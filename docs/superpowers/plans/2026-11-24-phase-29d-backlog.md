# Phase 29d — Clearing the Phase 29 backlog: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase 29 gate docs' open items:
- no false pagination template findings;
- exact unresolved references;
- counted structured-data drops;
- judged PDF hreflang;
- user-agent presets with their own robots token;
- fuller image sizes;
- a render pass no page can stop;
- less simhash garbage;
- link derivations with room under budget;
- a suite that leaves no process behind.

**Architecture:** Ten independent fixes, each in the module that owns the behaviour, plus gate
tooling.
- Two version bumps carry them: `RULESET_VERSION` 0.29.0 and `EXTRACTION_VERSION` 5.
- One data migration (`0061`) rewrites stored PDFs' `is_indexable`. Every other new value sits
  in jsonb (`structured_data_skips`, `validation_jsonb`, `config_jsonb`) or in an existing
  column (`links.target_page_id`).

**Tech Stack:** TypeScript strict ESM, Node 22, Postgres 16 + drizzle-kit, vitest, Playwright
(CDP). There are no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-phase-29d-backlog-design.md`. The owner approved
it on 2026-11-24 ("go ahead").

## Global Constraints

### Hard rules and process
- Hard rules 1–10 (CLAUDE.md) bind every task. In particular:
  - link work is SQL and `links` is never loaded into Node (rule 3);
  - RAM stays O(concurrency) (rule 6);
  - no silent fallbacks (rule 7);
  - politeness, including continuation reads through the host gate (rule 9).
- **Versions.**
  - `RULESET_VERSION` goes `0.28.1` → `0.29.0`, one bump for the phase. Task 1 makes it and
    opens `// 0.29.0: Phase 29d, Phase 29 backlog.` in the registry changelog; later tasks
    append to that entry.
  - `EXTRACTION_VERSION` goes `4` → `5` in Task 2, documented in the `src/crawl/versions.ts`
    doc block.
  - `RENDER_CAPTURE_VERSION` stays `3`: Task 8 changes no captured value.
- **Migrations.** Only with `npx drizzle-kit generate` and `npm run db:migrate`.
  - The next number is `0061`, Task 5a's data migration
    (`npx drizzle-kit generate --custom --name pdf_indexable`).
  - No other migration is expected. A task that finds it needs one stops and reports
    `NEEDS_CONTEXT`.
- **Not measured is never 0.** A count that a page's extraction did not record is null, and
  surfaces say "not measured".
- **Commits.** Each commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01LcXJUXzNFJZmzcTSA6omG2
  ```
- **Every task ends with** `npm test` and `npx tsc --noEmit` green.

### Pinned values (from the spec)
- **Pagination:** a type whose last segment is `:id` never joins the `:slug` family beside it.
- **Structured data:**
  - caps unchanged: `MAX_STRUCTURED_DATA_BLOCKS = 50`, `MAX_LD_JSON_DEPTH = 5`,
    `MAX_PROBLEMS_PER_LIST = 50`;
  - new skip keys `blocksDropped` and `nodesDropped`;
  - new validation field `unresolvedCount`.
- **Presets:** `ariadne` (default), `googlebot-smartphone`, `googlebot-desktop`, `bingbot`.
  `robotsUserAgent` matches `^[A-Za-z0-9_-]{1,64}$`.
- **Continuation reads:** at most `2` per image, PNG and JPEG only, each `65_536` bytes.
  `MAX_ROW_REQUESTS` grows by 2.
- **Render deadline:** `renderNavigationBudgetMs(...) + RENDER_POST_SETTLE_ALLOWANCE_MS +
  RENDER_AXE_ALLOWANCE_MS`.
- **simhash:** identical output; at least 5× less allocation per call.
- **Gate budgets:**
  - `GATE_LINK_DERIVE_MS = 60_000` covers `deriveLinkTargets` + `deriveLinkCounts` +
    `deriveLinkScore`, with a target of 40 s;
  - new `GATE_CLICK_DEPTH_MS = 30_000`;
  - local memory bound 306.4 MB, contract 512 MB.

### Standards, not Google (owner policy, 2026-11-16)
- Copy, evidence and docs judge nothing against Google's or Bing's policies.
- The preset table quotes each crawler's published user-agent string. That is an identity,
  not a policy, and it is the one place those names appear outside docs.

### Surface discipline
- `docs/talos-surface.md` and `docs/talos-integration.md` change in the same task as the
  surface they describe.
- MCP descriptions in `src/api/mcp.ts` change with the field.
- **Citations.** `docs/talos-surface.md` cites tests as `file:line` plus a quoted title
  fragment, and `test/skills/identifier-guard.test.ts` checks them.
  - Prefer new test files.
  - A task that inserts lines above a cited test fixes the citations in the same commit.
  - Every task runs `npx vitest run test/skills/identifier-guard.test.ts` green.
- **Databases.** Tests use the dev DB `ariadne`. Gate runs use `ariadne_gate29d`, created by the
  controller with the owner's OK.

## Review Focus

1. **A rules re-run on a crawl extracted before 29d.**
   - `blocksDropped` and `nodesDropped` read null (not measured), never 0.
   - A 0.28.x `validation_jsonb` without `unresolvedCount` is detected as stale and rewritten,
     never read as "no unresolved".
   - Page types are untouched, because inference runs at crawl close.
   - Pinned in Tasks 2, 3 and 4.
2. **A preset crawl whose robots.txt has no group for its token.**
   - It obeys `*`. That is the robots standard, not a fallback.
   - The robots evidence names the token that was matched, so a reader sees why.
   - Pinned in Task 6.
3. **A server that bends range requests on a continuation.**
   - Covers: 200 instead of 206, a `Content-Range` starting somewhere other than the offset
     asked for, a 416, a shorter body.
   - Each ends in `header-beyond-limit` with no third request, never a size parsed from the
     wrong bytes.
   - Pinned in Task 7.
4. **The render deadline firing in each phase.**
   - The phases are navigation, settle, measure, images, axe and content.
   - Each records the phase. The next page renders. The isolated world is re-created for that
     next page.
   - Pinned in Task 8.
5. **Links whose text target matches a non-OK page, or a page in another crawl.**
   - `deriveLinkTargets` scopes by `crawl_id`.
   - It sets the id whatever the target's fetch class. The consumers keep their own filters,
     so derived values are unchanged.
   - Pinned in Task 10 and by the gate's before/after comparison.

   As built (2026-11-24): `deriveLinkTargets` did not ship (Task 10's note), so the three
   derivations still join `links.target_url = pages.url` within the crawl, each with its
   own fetch-class filter; the gate's before/after comparison is the guard.

## Rulings made while planning

- **R1 — PDFs are indexable unless their headers say otherwise (owner, 2026-11-24).**
  - `pages.is_indexable` is true for a PDF that:
    - answers 200;
    - is `fetch_class = 'non_html'` with `content_type` matching `application/pdf`
      (case-insensitive, parameters ignored);
    - has no `saysNoindex(x_robots_tag)`.
  - The canonical is not read, as for HTML.
  - Task 5a sets it at persist, and data migration `0061` rewrites stored rows with the same
    SQL `SAYS_NOINDEX` (its parity with the JS `saysNoindex` is already tested).
  - Task 5a also audits every reader. Each reader that means "an indexable HTML page" gains
    `FETCHED_OK`.
  - Task 5b's `HREFLANG_DECLARER(alias)` is `FETCHED_OK(alias)` or (`fetch_class = 'non_html'
    and status_code = 200`). Indexability reads plain `is_indexable`.
  - Because the migration rewrites stored crawls, old crawls are judged too after a rules
    re-run.
- **R2 — `robotsUserAgent` is resolved once, when the crawl's config is built, and stored.** A
  new crawl's `config_jsonb` always carries it: from the preset, given, or derived. Every
  robots reader takes it from the config.
- **R3 — The preset strings.** These are the values on the date the plan was written. The
  implementer checks each against the engine's crawler documentation on the day and records
  that date in a comment.
  - `googlebot-smartphone`: `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P)
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${PRESET_CHROME_VERSION} Mobile Safari/537.36
    (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`, robots token `Googlebot`;
  - `googlebot-desktop`: `Mozilla/5.0 (compatible; Googlebot/2.1;
    +http://www.google.com/bot.html)`, robots token `Googlebot`;
  - `bingbot`: `Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)`,
    robots token `bingbot`.
  - `PRESET_CHROME_VERSION` is a named constant with its date. Google's docs write the version
    as `W.X.Y.Z`.
- **R4 — Continuation validity.**
  - A continuation is sent only when the first answer was a 206 that carried a total.
  - Its answer must be a 206 whose `Content-Range` starts exactly at the offset asked for.
    Anything else ends the walk with `header-beyond-limit`.
  - A continuation that would start at or past the total also ends the walk with
    `header-beyond-limit`.
- **R5 — The render deadline text.** `render over ${seconds} s in total (during ${phase})`,
  where `phase` is one of `navigation`, `settle`, `measure`, `images`, `axe`, `content`.
  - The page counts as not rendered (`failure()`).
  - The axe status, if axe was running, is `timeout`.
- **R6 — The click-depth frontier.**
  - Task 10 first tries a temp frontier table: `cd_frontier(page_id)`, refilled per level.
  - If that does not reach ≤ 30 s on the gate, it measures a partial index on
    `pages(crawl_id, click_depth)` instead.
  - Either way, the choice and both timings go in the commit message.
- **R7 — The before/after comparison** runs both rule versions on **one** gate crawl.
  - First, rules at `12e832e` from a detached worktree; export the derived columns.
  - Then, rules at the branch head; export again; compare.
  - This works because no migration separates them.
- **R8 — The test child reaper** is a vitest `globalSetup` module, `test/setup/child-reaper.ts`.
  It hands a temp directory to workers in `ARIADNE_TEST_PID_DIR`. Each test-spawned child
  writes `<pid>` there, and teardown kills every listed pid that is still alive.

## File map

| Task | Main files |
|---|---|
| 1 | `src/crawl/page-type.ts`, `src/rules/registry/registry.ts`, `test/crawl/page-templates.test.ts` |
| 2 | `src/crawl/parse/microdata.ts`, `src/crawl/parse/rdfa.ts`, `src/crawl/parse/item-core.ts`, `src/crawl/parse/page-analyzer.ts`, `src/crawl/versions.ts`, `src/crawl/persist.ts` |
| 3 | `src/api/structured-data.ts`, `src/api/service.ts`, `src/api/csv.ts`, `src/api/mcp.ts`, `docs/talos-surface.md` |
| 4 | `src/rules/schema-org/validate.ts`, `src/rules/schema-org/blob-sql.ts`, `src/rules/query/schema-validation.ts`, `src/rules/derive/schema-validation.ts`, surfaces |
| 5a | `src/crawl/persist.ts`, `src/crawl/robots-directives.ts`, `drizzle/0061_pdf_indexable.sql`, every HTML-only `is_indexable` reader |
| 5b | `src/rules/helpers.ts`, `src/rules/query/hreflang.ts`, `src/rules/query/hreflang-integrity.ts`, `src/rules/query/hreflang-completeness.ts` |
| 6 | new `src/crawl/user-agents.ts`; `src/crawl/loop.ts`, `src/api/config-schema.ts`, `src/crawl/discovery.ts`, `src/crawl/resources/fetch-resources.ts`, `src/rules/query/robots.ts`, `src/rules/crawl-evidence.ts`, `src/api/service.ts`, `src/api/mcp.ts` |
| 7 | `src/crawl/resources/image-size.ts`, `src/crawl/resources/fetch-resources.ts` |
| 8 | `src/crawl/render/renderer.ts`, `src/crawl/render/run-render.ts` |
| 9 | `src/crawl/parse/simhash.ts` |
| 10 | new `src/rules/derive/link-targets.ts`; `src/rules/run.ts`, `src/rules/derive/{click-depth,link-counts,link-score}.ts`, `scripts/gate-rules.ts` |
| 11 | `test/worker/serve.test.ts`, new `test/setup/child-reaper.ts`, `vitest.config.ts` |
| 12 | new `scripts/gate-derived.ts` |
| 13 | controller: gate run and `docs/gates/phase-29d.md` |

Task 11 runs first, so later suite runs leave no strays. After that the order is 1 → 10, then
12 → 13.

---

### Task 11 (run first): The suite leaves no process behind

**Files:**
- Modify: `test/worker/serve.test.ts`, `vitest.config.ts`
- Create: `test/setup/child-reaper.ts`, `test/setup/child-reaper.test.ts`

**Interfaces:**
- Produces:
  - `registerTestChild(proc: ChildProcess): void`, exported from `test/setup/child-reaper.ts`.
    It writes the pid file and removes it on exit.
  - The default export is vitest's `globalSetup` (setup + teardown).

- [ ] **Step 1: Write the failing tests** in `test/setup/child-reaper.test.ts`:
  - `"registerTestChild writes the pid and removes it when the child exits"`: spawn
    `node -e "setTimeout(()=>{},200)"`, register it, and assert the file exists. Await exit and
    assert the file is gone.
  - `"teardown kills a registered child that is still alive"`: spawn
    `node -e "setInterval(()=>{},1000)"`, register it, call the teardown function directly, and
    assert `process.kill(pid, 0)` throws `ESRCH` within 2 s.
- [ ] **Step 2:** Run `npx vitest run test/setup/child-reaper.test.ts`. Expect a FAIL (module
  missing).
- [ ] **Step 3: Implement.**
  - The reaper per R8. Wire it as `globalSetup` in `vitest.config.ts`.
  - In `serve.test.ts`:
    - `launch()` calls `registerTestChild` and pushes to `children[]` for every spawn
      (`:164`).
    - `afterEach` SIGTERMs, waits up to 5 s, then SIGKILLs.
    - `spawnTrusted`'s ready timeout (`:183`) kills its child before rejecting.
    - The `until(...)` in the "never reads a process-trust variable" test (`:514`) gets a
      `45_000` ms limit, below the 60 s `testTimeout`.
- [ ] **Step 4:**
  - Run `npx vitest run test/worker/serve.test.ts test/setup`. Expect a PASS.
  - Then run `npm test`. After it, `pgrep -f "src/worker/serve.ts"` must print nothing.
- [ ] **Step 5:** Commit `test(worker): every spawned child is registered and reaped (29d)`.

### Task 1: Pagination is its own page type; ruleset 0.29.0

**Files:**
- Modify:
  - `src/crawl/page-type.ts`: `familyOf` (`:141-146`) and the SQL in `inferPageTemplates`
    (`:258-400`).
  - `src/rules/registry/registry.ts`: the bump.
  - `test/crawl/versions.test.ts` or wherever the ruleset version is pinned.
- Test: `test/crawl/page-templates.test.ts`

**Interfaces:**
- Produces: `familyOf(type)` returns `type` unchanged when its last segment is `:id`.

- [ ] **Step 1: Write the failing tests** in `page-templates.test.ts`:
  - `"pagination keeps :id beside a slug type"`. `typesAfter([...generated("/blog/", 20, 3),
    "/blog/2", "/blog/3", "/blog/10"])` gives the keys `["/blog/:id", "/blog/:slug"]`, with
    `/blog/:id` → 3 and `/blog/:slug` → 20.
  - `"a trailing slash does not change it"`: the same with `"/blog/10/"`.
  - `"a dated segment still joins nothing new"`: `/news/2024-01-05` stays `/news/:date`.
  - The SQL-vs-oracle parity test (`:540`) gains these three inputs.
  - Keep `:188` and `:196` unchanged. Both must still pass.
- [ ] **Step 2:** Run `npx vitest run test/crawl/page-templates.test.ts`. Expect a FAIL on the
  new tests.
- [ ] **Step 3: Implement** the `familyOf` change, and the same rule in the SQL's family
  expression.
  - Bump `RULESET_VERSION` to `0.29.0` and open the changelog entry: "page types: a numeric
    last segment keeps `:id` beside a slug type".
  - Update every test that pins `0.28.1` (search for the string).
- [ ] **Step 4:**
  - Run `npx vitest run test/crawl/page-templates.test.ts test/rules/schema-validation-query.test.ts`.
  - Then `npx vitest run test/fixtures/harness.test.ts`. The `/authored29a/tpl/:id` template is
    unaffected.
  - Then `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `fix(page-type): pagination keeps :id beside a slug type (29d)`.

### Task 2: Extraction 5 — every type token, drops counted

**Files:**
- Modify:
  - `src/crawl/parse/microdata.ts`: `itemTypeOf` (`:120-125`).
  - `src/crawl/parse/rdfa.ts` (`:105-115`, `:171-176`).
  - `src/crawl/parse/item-core.ts`: `@type` is a string or a string array; skips type.
  - `src/crawl/parse/page-analyzer.ts`: the shared sink (`:1652`), `collectLdJsonNodes`
    (`:1505`), `flushLdJson` (`:2377`), and the depth walk.
  - `src/crawl/versions.ts`: 5 plus its doc entry.
  - `src/crawl/persist.ts`: the skips shape.
  - The three tests that pin 4: `test/crawl/versions.test.ts:47`,
    `test/crawl/persist.test.ts:606`, `test/fixtures/harness.test.ts:4746`.
- Test: `test/crawl/microdata.test.ts`, `test/crawl/analyzer-extensions.test.ts`, new
  `test/crawl/rdfa-types.test.ts`

**Interfaces:**
- Produces:
  - `StructuredDataSkips` gains `blocksDropped: number` and `nodesDropped: number`, always
    present on extraction-5 pages.
  - Item `@type` is `string | string[]`. It is an array only when there are 2 or more tokens,
    in document order, deduplicated.
  - `schema_type` is the first token.

- [ ] **Step 1: Write the failing tests:**
  - **microdata.test.ts:**
    - `"keeps every itemtype token"`: `itemtype="https://schema.org/Event https://schema.org/Festival"`
      gives `@type` `["Event","Festival"]` and `schema_type` `"Event"`.
    - Change `:179`: `Event http://example.org/Other` now keeps both tokens as they are written
      by the extraction's name rules. Read `itemTypeOf`'s naming first, and assert the second
      token exactly as the extraction names a non-schema.org URL.
  - **rdfa-types.test.ts:**
    - `typeof="schema:Product schema:Offer"` gives both;
    - `typeof="schema:Product foaf:Thing"` keeps `Product` and is **not** counted in
      `rdfaUnsupported`;
    - `typeof="foaf:Thing"` alone is counted, as today.
  - **analyzer-extensions.test.ts:**
    - `"counts blocks past the cap"`: 60 JSON-LD blocks give 50 stored and `blocksDropped: 10`.
      The parse-failure count is unchanged (extend `:233`).
    - `"counts nodes past the depth cap"`: a JSON-LD graph 7 levels deep gives
      `nodesDropped` equal to the number of nodes at depths 6–7.
    - `"zero when nothing is dropped"`: both keys are `0`.
- [ ] **Step 2:** Run the three files. Expect a FAIL.
- [ ] **Step 3: Implement.**
  - Counting happens where each cap drops. Nothing is retained beyond the counters.
  - Bump `EXTRACTION_VERSION` to 5, with a doc block line: "29d: every itemtype/typeof token;
    blocksDropped and nodesDropped".
  - Update the three pins.
  - Rules gate on `>= 4` (`v4Gate`) and keep passing. No rule reads the new keys in this task.
- [ ] **Step 4:** Run `npx vitest run test/crawl test/rules/schema-validate.test.ts`, then
  `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(extract): extraction 5 — every type token, dropped blocks and
  nodes counted (29d)`.

### Task 3: Dropped counts on the structured-data surfaces

**Files:**
- Modify:
  - `src/api/structured-data.ts`;
  - `src/api/service.ts`: `StructuredDataPageRow` (`:2453`), `:7203`, `:7209`, `:7247`;
  - `src/api/csv.ts` (`:1081`);
  - `src/api/mcp.ts`: the `structured_data` tool (`:1841`, `:1864`);
  - `docs/talos-surface.md`.
- Test: `test/api/structured-data.test.ts`, `test/api/mcp.test.ts`

**Interfaces:**
- Consumes: Task 2's skip keys.
- Produces: page rows gain `blocksDropped: number | null` and `nodesDropped: number | null`.
  Null means the page's extraction is below 5.

- [ ] **Step 1: Write the failing tests.**
  - An extraction-5 page with 60 blocks lists `blocksDropped: 10` and `nodesDropped: 0`.
  - An extraction-4 page lists both as `null` and keeps `blocksAtCap` as it is computed today.
  - On an extraction-5 page, `blocksAtCap` equals `blocksDropped > 0`.
  - The CSV carries both columns, with an empty cell for null.
  - The MCP description names both.
- [ ] **Step 2:** Run the two files. Expect a FAIL.
- [ ] **Step 3: Implement.**
  - Read the keys from `structured_data_skips` in SQL (`(skips->>'blocksDropped')::int`).
  - Absence on an extraction-5 page is a loud error, not null.
  - Update the docs, then run the identifier guard.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(api): blocksDropped and nodesDropped on structured-data listings
  (29d)`.

### Task 4: Unresolved references found wherever they sit

**Files:**
- Modify:
  - `src/rules/schema-org/validate.ts` (`:102`, `:276-292`, `:446`, zod `:117`, `:139`);
  - `src/rules/schema-org/blob-sql.ts`;
  - `src/rules/query/schema-validation.ts`: `unresolvedHas` (`:172-181`), evidence (`:288`),
    rule (`:459-480`);
  - `src/api/structured-data.ts`: `blockProblemsCapped` (`:221-226`);
  - `src/api/service.ts`, `src/api/mcp.ts`;
  - `src/rules/registry` copy (the "stops at 50" text, `test/rules/copy.test.ts:2100`);
  - `docs/talos-surface.md`.
- Test: `test/rules/schema-validate.test.ts`, `test/rules/schema-validation-query.test.ts`,
  `test/api/structured-data.test.ts`

**Interfaces:**
- Produces:
  - The block validation gains `unresolved: string[]` (max 50, walk order) and
    `unresolvedCount: number` (exact).
  - `references` keeps its role and cap.
  - Evidence: `{unresolved, unresolvedCount, problemsCapped}`, where `problemsCapped` is
    `unresolvedCount > 50`.

- [ ] **Step 1: Write the failing tests:**
  - **schema-validate.test.ts:**
    - `"finds an unresolved reference past the 50th"`: 59 resolving references, then one bare
      `{"@id":"#nowhere"}`, gives `unresolvedCount: 1` and `unresolved: ["#nowhere"]` (as the
      validator writes ids).
    - `"counts every unresolved reference"`: 70 unresolved give `unresolved.length === 50` and
      `unresolvedCount: 70`.
  - **schema-validation-query.test.ts:**
    - the page from the first case gets a `schema.unresolved-reference` finding;
    - I1 (`:759-777`) is updated to the new evidence.
  - **Stale blob:**
    - a `validation_jsonb` written without `unresolvedCount` is selected by `blob-sql`'s stale
      check;
    - a rules run rewrites it, and the finding appears.
- [ ] **Step 2:** Run the files. Expect a FAIL.
- [ ] **Step 3: Implement.**
  - The pre-filter is `(block->>'unresolvedCount')::int > 0`.
  - The copy says the evidence lists up to 50 and gives the exact count.
  - Append to the 0.29.0 changelog. Update the docs, then run the identifier guard.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `fix(schema): unresolved references are found wherever they sit (29d)`.

### Task 5a: PDFs are indexable unless their headers say otherwise

**Files:**
- Modify:
  - `src/crawl/persist.ts`: `isIndexable` (`:1062`);
  - `drizzle/0061_pdf_indexable.sql` (custom, generated);
  - each `is_indexable` reader that means an HTML page. Audit all 19 files:
    `grep -rn "is_indexable\|isIndexable" src/`.
  - `docs/talos-surface.md`.
- Test: new `test/crawl/pdf-indexable.test.ts`, new `test/db/pdf-indexable-migration.test.ts`

**Interfaces:**
- Produces: `isPdf(contentType: string | null): boolean`, exported from
  `src/crawl/robots-directives.ts` beside `saysNoindex`, and its SQL twin
  `IS_PDF(column: string): string` in `src/rules/helpers.ts`, with a parity test.

- [ ] **Step 1: Write the failing tests:**
  - **persist:** a 200 `application/pdf` with no `X-Robots-Tag` is stored `is_indexable = true`.
    These are stored false:
    - `X-Robots-Tag: noindex`;
    - `X-Robots-Tag: none`;
    - a 404 PDF;
    - a 200 `application/msword`;
    - a 200 `image/png`.

    `application/PDF; charset=binary` counts as a PDF.
  - **migration:** insert the same five shapes with `is_indexable = false`, run the migration's
    SQL, and assert only the plain 200 PDF flips. An HTML row is untouched.
  - **The reader audit (one test per guarded reader):** a crawl with an indexable PDF and an
    indexable HTML page.
    - Each HTML-only reader ignores the PDF: render selection, duplicate titles and
      descriptions, content rules, page-level indexability and canonical rules.
    - Each document reader counts it: the health metric's indexable count, sitemap
      non-indexable (a PDF in the sitemap is no longer flagged), the link-target rules.
  - **`isPdf` / `IS_PDF` parity** over `application/pdf`, `Application/PDF;x=1`, `text/html`,
    null.
- [ ] **Step 2:** Run the new files. Expect a FAIL.
- [ ] **Step 3: Implement.**
  - Change `isIndexable`. Generate the custom migration and write its `update pages set
    is_indexable = true where …` from `IS_PDF` and `SAYS_NOINDEX`. Apply it with
    `npm run db:migrate`.
  - Add `FETCHED_OK` to each HTML-only reader. List every reader and its verdict (document or
    HTML) in the commit message.
  - Append to the changelog ("PDFs are indexable unless X-Robots-Tag says noindex"). Update the
    docs, then run the identifier guard.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `fix(indexability): a PDF is indexable unless its headers say
  otherwise (29d)`.

### Task 5b: A PDF's hreflang set is judged

**Files:**
- Modify:
  - `src/rules/helpers.ts`: `HREFLANG_DECLARER` (R1), beside `FETCHED_OK`;
  - `src/rules/query/hreflang.ts`: `isAuditable` (`:305`), `:466`, `:542`, `:620`, `:697`,
    `:924`, `:1013`;
  - `src/rules/query/hreflang-integrity.ts` (`:87`);
  - `src/rules/query/hreflang-completeness.ts` (`:266`);
  - `docs/talos-surface.md`.
- Test: new `test/rules/hreflang-pdf-query.test.ts`; update `test/rules/hreflang-query.test.ts:908-914`.

**Interfaces:**
- Consumes: Task 5a's `is_indexable` for PDFs.
- Produces: `HREFLANG_DECLARER(alias: string): SQL`.

- [ ] **Step 1: Write the failing tests** in `hreflang-pdf-query.test.ts`. The fixture rows
  follow `test/crawl/persist.test.ts:1131`'s shape.
  - **`"a PDF that declares an alternate with no return link gets missing-return-link"`.**
    `/doc.pdf` is `non_html` 200 with header rows `en` → self and `de` → `/de/doc.pdf`.
    `/de/doc.pdf` is `non_html` 200 with only `de` → self. The finding names `/doc.pdf` as the
    declarer.
  - **`"a PDF with X-Robots-Tag noindex is a non-indexable target"`.** An HTML page declares
    the PDF as an alternate, and the PDF's `x_robots_tag` is `noindex`, so
    `hreflang.non-indexable-target` fires.
  - **`"a plain 200 PDF is an indexable target"`:** an HTML page declaring it gets no
    `hreflang.non-indexable-target`.
  - **`"an invalid code in a PDF's Link header is reported"`.**
  - **`"a 404 PDF is not a declarer"`:** a `non_html` 404 with header rows produces no
    findings.
  - Update `hreflang-query.test.ts:908-914`. A `non_html` **200** is now judged. Keep its
    non-200 cases silent.
- [ ] **Step 2:** Run the new file. Expect a FAIL.
- [ ] **Step 3: Implement.**
  - Every declarer gate uses `HREFLANG_DECLARER`. Indexability reads `is_indexable`, which
    Task 5a made true for PDFs.
  - `FETCHED_OK` is not changed.
  - Append to the changelog. Update the docs ("a declarer can be a PDF"), then run the
    identifier guard.
- [ ] **Step 4:** Run `npx vitest run test/rules/hreflang*`, then `npm test` and
  `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(hreflang): a PDF's Link-header set is judged like a page's
  (29d)`.

### Task 6: User-agent presets with their own robots token

**Files:**
- Create: `src/crawl/user-agents.ts`
- Modify:
  - `src/crawl/loop.ts`: `CrawlConfig` (`:161`), `CRAWL_DEFAULTS` (`:552`),
    `parseStoredConfig` (`:1212`, `:1250`), validation (`:1398`), `discover()` call
    (`:1905`).
  - `src/api/config-schema.ts`: `CRAWL_FIELDS` (`:304`, `:335-342`), start body (`:863`).
  - `src/crawl/discovery.ts`: `DiscoveryOpts`, `robotsRulesOf` call sites (`:1232-1242`).
  - `src/crawl/resources/fetch-resources.ts` (`:564`).
  - `src/rules/query/robots.ts` (`:132-162`) and `src/rules/crawl-evidence.ts` (`:631`):
    `robotsUserAgentOf`.
  - `src/api/service.ts`: the robots read-out (`:3884`).
  - `src/api/mcp.ts` (`:1126`, `:1140`, `:1219`, `:1964-1983`).
  - `docs/talos-surface.md`, `docs/talos-integration.md`.
- Test: new `test/crawl/user-agents.test.ts`; `test/api/config-schema.test.ts` (or wherever
  `CRAWL_FIELDS` is tested); `test/crawl/discovery.test.ts`; `test/rules/robots-query.test.ts`

**Interfaces:**
- Produces:
  - `type UserAgentPreset = "ariadne" | "googlebot-smartphone" | "googlebot-desktop" | "bingbot"`;
  - `USER_AGENT_PRESETS: Record<UserAgentPreset, {userAgent: string; robotsUserAgent: string}>`;
  - `resolveCrawlIdentity(input: {userAgentPreset?: string; userAgent?: string;
    robotsUserAgent?: string}): {userAgentPreset: UserAgentPreset | null; userAgent: string;
    robotsUserAgent: string}`. It throws a 400-mapped error with the exact messages below.
  - `CrawlConfig` gains `robotsUserAgent: string` and `userAgentPreset: UserAgentPreset | null`.
  - `robotsUserAgentOf(config): string | null`. Null means a crawl stored before 29d.

- [ ] **Step 1: Write the failing tests** in `user-agents.test.ts`:
  - **The default:** no input gives `ariadne`, today's `CRAWL_DEFAULTS.userAgent`, and robots
    token `AriadneBot`.
  - **Each preset** gives R3's strings and tokens. Snapshot the table.
  - **A preset with `userAgent`:** throws `"userAgentPreset and userAgent cannot both be set"`.
    The same with `robotsUserAgent`.
  - **A custom `"Acme/1.0 (+https://acme.test)"`** derives `Acme`.
  - **A custom `"Mozilla/5.0 (compatible; Acme/1.0)"` with no token** throws `"userAgent starts
    with Mozilla/; robots rules would be matched as 'mozilla'. Set robotsUserAgent."`.
  - **The same with `robotsUserAgent: "Acme"`** is accepted.
  - **`robotsUserAgent: "Acme Bot"`** throws `"robotsUserAgent must be one product token
    (letters, digits, - and _)"`.
  - **Unknown preset:** `"unknown userAgentPreset; expected one of ariadne, googlebot-smartphone,
    googlebot-desktop, bingbot"`.
  - **`discovery.test.ts`:** a robots.txt with `User-agent: Googlebot` / `Disallow: /g` and
    `User-agent: *` / `Disallow: /s`.
    - With the `googlebot-desktop` preset, `/g` is disallowed and `/s` allowed. With the
      default, the reverse.
    - The request header is the preset's full string.
    - Add a `Crawl-delay` in the Googlebot group, read through the token.
  - **`robots-query.test.ts`:**
    - the stored token picks the group, and the evidence carries `robotsUserAgent`;
    - a pre-29d crawl (config without the token) is read with the full `userAgent`, as today
      (`:246` unchanged);
    - `:264` (no user agent at all) still refuses.
  - **The config surface:**
    - the start body accepts both fields;
    - `crawl_config_set` refuses both (`mutable: "never"`);
    - `crawl_get` echoes the resolved trio.
- [ ] **Step 2:** Run the files. Expect a FAIL.
- [ ] **Step 3: Implement** per R2 and R3.
  - Every robots read takes `robotsUserAgent`: discovery, resources, `getCrawlDelay`, the rule
    and the service read-out.
  - Every request header keeps `userAgent`: page, probe, discovery, resources, recheck,
    renderer.
  - In the docs and MCP descriptions, state the IP and reverse-DNS verification limit, and that
    a preset never bypasses a challenge.
  - Run the identifier guard.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(crawl): user-agent presets and a robots token of their own
  (29d)`.

### Task 7: Image headers past 64 KiB

**Files:**
- Modify:
  - `src/crawl/resources/image-size.ts`: `readPng` (`:154-186`) and the JPEG walk
    (`:259-278`).
  - `src/crawl/resources/fetch-resources.ts`:
    - the module header (`:12-26`);
    - `MAX_ROW_REQUESTS` (`:290-299`);
    - the range request (`:1294`), `readHead` (`:1311-1317`, `:1386`), `contentRangeTotal`
      (`:1097`).
- Test: `test/crawl/image-size.test.ts`, `test/crawl/fetch-resources.test.ts`

**Interfaces:**
- Produces: the parser answer becomes `{kind: "size", ...} | {kind: "reason", reason} |
  {kind: "need", offset: number, state: ImageWalkState}`.
  - `parseImageHead(bytes, state?)` resumes from `state`.
  - The exact type names are the implementer's. The three kinds and the resumable state are
    fixed.

- [ ] **Step 1: Write the failing tests:**
  - **image-size.test.ts:**
    - `"a square PNG past 64 KiB reports its IHDR size"`: 300×300 with 100 KiB of private chunks
      before IDAT and no eXIf.
    - The `:202` 40×20 case now answers `need` at the next chunk header's offset.
    - Fed that window, it resolves to 40×20. With an eXIf of orientation 6 found there, it
      resolves to 20×40.
    - A JPEG with 100 KiB of APP segments before SOF answers `need`, then its size.
  - **fetch-resources.test.ts**, against a fixture server that honours ranges:
    - the 40×20 PNG and the JPEG get sizes, with `requests` counting 2;
    - **R4 cases**, each ending `header-beyond-limit` with no further request:
      - a continuation answered 200;
      - a continuation answered 206 with `Content-Range` starting at the wrong offset;
      - 416;
      - a third `need`;
    - the reads go through the host gate. Assert the gate's acquire count.
- [ ] **Step 2:** Run both files. Expect a FAIL.
- [ ] **Step 3: Implement** per R4.
  - Reword the module header to "at most 4 requests plus its redirect hops".
  - The fuzz test (around `image-size.test.ts:353`) must keep passing.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(resources): square PNGs and continuation reads past the 64 KiB
  window (29d)`.

### Task 8: A hostile page costs one page

**Files:**
- Modify:
  - `src/crawl/render/renderer.ts`:
    - `MEASURE_SCRIPT` (`:689-702`) and its call (`:2517`);
    - `isolatedEvaluate` (`:1578-1601`);
    - `failure()` (`:2835`);
    - the per-page render flow (`:2510-2590`).
  - `src/crawl/render/run-render.ts`: pass the deadline from `renderNavigationBudgetMs`
    (`:231-262`) and the two allowances (`:184`, `:196`).
- Test: `test/crawl/renderer.test.ts` (new tests at the end of the file, so no citation shifts)

**Interfaces:**
- Produces:
  - `renderPageDeadlineMs(navigationBudgetMs: number): number`, exported from `run-render.ts`;
  - `isMeasurement(value: unknown): value is Measurement`.

- [ ] **Step 1: Write the failing tests** (a real browser against the fixture server, as the
  file does today):
  - **`"a page that overrides Array.from and Array.prototype.filter is measured"`.** The
    measurements equal those of the same page without the overrides.
  - **`"a measurement of the wrong shape fails that page only"`.**
    - Inject through a test seam that replaces the measure expression with one returning
      `{words: "x"}`.
    - The row has `render_error` starting `"measurement returned an invalid shape"`.
    - The next page renders.
  - **`"a page that never yields is stopped at the deadline"`.**
    - A fixture script runs `for(;;){}` after load, and the test sets a small deadline through
      the existing scaled-timing options.
    - The row records `render over N s in total (during measure)`, the following page renders,
      and the pass completes.
  - **One test per phase.** Each phase in R5 records its own name. Use the cheapest hang for
    each:
    - navigation: a never-answering server;
    - settle: a page that keeps fetching;
    - axe: axe's existing fault seam.
  - **`"renderPageDeadlineMs is the lease's sum"`.**
- [ ] **Step 2:** Run `npx vitest run test/crawl/renderer.test.ts -t "hostile|deadline|shape"`.
  Expect a FAIL.
- [ ] **Step 3: Implement.**
  - `MEASURE_SCRIPT` goes through `isolatedEvaluate`, and its result through `isMeasurement`.
  - One deadline timer per page. On expiry:
    1. `Runtime.terminateExecution` on the isolated context;
    2. close the page;
    3. return `failure()` with R5's text.
  - A throw from our own code still stops the pass.
- [ ] **Step 4:** Run the whole `test/crawl/renderer.test.ts` and
  `test/fixtures/harness.test.ts`, then `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `fix(render): measurement in the isolated world, one deadline per page
  (29d)`.

### Task 9: `simhash64` without the garbage

**Files:**
- Modify: `src/crawl/parse/simhash.ts` (`:26-64`)
- Test: `test/crawl/simhash.test.ts`

**Interfaces:**
- Unchanged: `simhash64(text: string): bigint`.

- [ ] **Step 1: Write the failing tests:**
  - **The oracle.** Copy today's implementation into the test file as `simhash64Oracle`.
  - **`"matches the oracle on random text"`:** 2,000 seeded random texts mixing ASCII words,
    accented letters, CJK, emoji (surrogate pairs), runs of whitespace, and texts of 0–3
    words. Every result is equal.
  - **`"allocates at least 5x less than the oracle"`:**
    - follow `test/crawl/a11y.test.ts:52-80`'s `HeapProfiler.startSampling` pattern;
    - hash a 2,000-word text 50 times with each;
    - sum the sampled allocation under each function's frames;
    - assert `oracle / new >= 5`.
  - The four golden values (`:45-52`) stay as they are.
- [ ] **Step 2:** Run `npx vitest run test/crawl/simhash.test.ts`. Expect the allocation test
  to FAIL.
- [ ] **Step 3: Implement.**
  - FNV-1a 64 runs on two 32-bit halves with `Math.imul` and carries.
  - Each 4-word window is hashed by feeding words and single spaces into the hash state. No
    joined strings, no window arrays.
  - The lo/hi tally stays. One BigInt is built at the end.
- [ ] **Step 4:** Run `npx vitest run test/crawl/simhash.test.ts
  test/crawl/analyzer-extensions.test.ts`, then `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `perf(simhash): FNV on 32-bit halves, no per-window strings (29d)`.

### Task 10: Link derivation with room to spare

**Files:**
- Create: `src/rules/derive/link-targets.ts`
- Modify:
  - `src/rules/run.ts`: derivation order (`:112-118`). `deriveLinkTargets` goes before
    `deriveClickDepth`.
  - `src/rules/derive/click-depth.ts` (`:223-251`), `src/rules/derive/link-counts.ts`,
    `src/rules/derive/link-score.ts` (`:131-141`): join on `l.target_page_id`.
  - `scripts/gate-rules.ts`:
    - `GATE_LINK_DERIVE_MS` (`:119`) covers the three named derivations;
    - add `GATE_CLICK_DEPTH_MS = 30_000`;
    - the sum at `:1402-1410` and the assert at `:1529-1531`.
- Test: new `test/rules/derive-link-targets.test.ts`; the existing
  `test/rules/derive-{click-depth,link-counts,link-score}.test.ts` stay green **unchanged**.

**Interfaces:**
- Produces: `deriveLinkTargets(db: Db, crawlId: string): Promise<{links: number; resolved:
  number; written: number}>`.

- [ ] **Step 1: Write the failing tests** in `derive-link-targets.test.ts`:
  - **Resolution:**
    - internal links to a crawled URL get that page's id, whatever its fetch class (OK, 404,
      redirect);
    - links to an uncrawled URL stay null;
    - external links stay null.
  - **Another crawl:** a second crawl with the same URLs resolves to its own page ids only.
  - **Re-run:** a second run reports `written: 0`.
  - **A stale id:** an id set by hand to another page is corrected.
  - **Through `runRules`:** `summary.derivedMs.deriveLinkTargets >= 0`, and it runs before
    `deriveClickDepth`.
- [ ] **Step 2:** Run it. Expect a FAIL.
- [ ] **Step 3: Implement.**
  - One guarded `update links l set target_page_id = p.id from pages p where …
    l.target_page_id is distinct from p.id`.
  - Plus one statement that nulls ids whose target no longer matches.
  - Switch the three consumers to the integer join. Add click depth's frontier per R6.
- [ ] **Step 4:**
  - The three existing derive test files pass unchanged.
  - Run `gate-rules` at `GATE_PAGES=2500` on the dev DB and note the timings in the commit
    message.
  - Delete the smoke crawl through the API's crawl delete.
  - Then `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `perf(rules): resolve link targets once; integer joins in the link
  derivations (29d)`.

**As built (2026-11-24).** `deriveLinkTargets` was measured and NOT shipped. Persisting
`links.target_page_id` cost about 70 s at 50k on a first run (68.6 s for the `SET`, against
about 11 s the integer joins saved). A shared session temp table of resolved targets (no
persisted id, read by all three derivations) measured 88–89 s for link derive on the
synthetic 50k, against 70.6 s for the URL joins plus the click-depth frontier table. So all
three derivations still join `links.target_url = pages.url`, and the `(crawl_id,
target_page_id)` index stays unused. Click depth uses the `cd_frontier` temp-table pair
(24.1 → 8.6 s on the synthetic 50k; the partial-index variant measured 24.0 s).
`GATE_LINK_DERIVE_MS` (60 s) covers counts + score only, and `GATE_CLICK_DEPTH_MS` (30 s)
click depth. The 40 s target and "comfortable room" are likely unmet: link counts alone is
about 53 s on the synthetic 50k (24.6 s on the 29c gate crawl). Whether the 60 s clause
stands is an owner decision at the gate. Shipped as `5ff0892 perf(rules): click-depth frontier table; link-target
resolution measured and dropped (29d)`, with no `derive-link-targets` test and no change to
the gate's sum.

### Task 12: Gate tooling — derived-value export and compare

**Files:**
- Create: `scripts/gate-derived.ts`, `test/scripts/gate-derived.test.ts`

**Interfaces:**
- CLI:
  - `--export --crawl <id> --out <file>` writes `{url, clickDepth, inlinksInternal,
    outlinksInternal, outlinksExternal, linkScoreRaw, linkScore}` per page, sorted by URL.
  - `--compare <a> <b>` exits 1 and lists the first 20 differences.
  - Integers compare exactly. `linkScoreRaw` compares within `1e-9` relative.
  - The database name must start with `ariadne_gate`. `--smoke` lifts that check.

- [ ] **Step 1:** Write the test for the compare function: equal files pass, a 1-off depth
  fails, and a raw-score difference of `1e-12` relative passes. Run it; expect a FAIL.
- [ ] **Step 2:** Implement. Stream the export row by row with a cursor, never as a whole
  result set (hard rule 6).
- [ ] **Step 3:**
  - Smoke: `--export --smoke` on the Task 10 smoke crawl before deleting it.
  - Then `npm test` and `npx tsc --noEmit`.
- [ ] **Step 4:** Commit `test(gate): derived-value export and compare (29d)`.

### Task 13 (controller, not a subagent): gate run and record

This needs the owner's OK to create `ariadne_gate29d`, and a separate OK for the lavishalice.com
crawl.

1. **Database.** Create it with `npm run db:migrate`.
2. **Clause 1.**
   - The suite and `tsc` are clean.
   - `pgrep -f src/worker/serve.ts` prints nothing after `npm test`.
3. **Clause 3.**
   - Run `gate-rules` at 50k on the branch head and record the peaks and `derivedMs`.
   - Link derive ≤ 60 s (target 40 s); click depth ≤ 30 s.
   - Peak ≤ 306.4 MB local and ≤ 512 MB contract.
4. **R7.**
   - Export the derived values. Re-run rules on the same crawl from a detached worktree at
     `12e832e`, then export again.
   - `gate-derived --compare` must pass.
   - Re-run rules at the head afterwards, so the crawl ends on 0.29.0.
5. **Clause 2.** The task tests are the evidence. List each fixture by test title.
6. **Clause 4.** Task 9's allocation test is the evidence. Record its ratio.
7. **Clause 5** (owner OK). Crawl lavishalice.com.
   - `schema.template-inconsistent` must not list the `/blog/<n>/` pages.
   - Explain every other rule's count change against the 29c crawl.
8. **Record.**
   - Write `docs/gates/phase-29d.md`, shaped like `phase-29c.md`, with its open items.
   - Mark the closed items in the 29a, 29b and 29c gate docs' open-items sections as done in
     29d.
   - Set `CLAUDE.md` to "Phases 0–29d are shipped".

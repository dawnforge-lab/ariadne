# Phase 26a: Rules over existing data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 40 new rules that read only what crawls already store: 39 from the spec's 26a table plus one NOT MEASURED marker. Also one thresholds module, a SERP glyph table we measure ourselves, and a black-box calibration against Screaming Frog. No migration, no re-crawl. Ruleset 0.20.0.

**Architecture:**
- Every verdict threshold moves into `src/rules/thresholds.ts`, and the owning files re-export it.
- New rules sit in new, focused files beside the existing families. Page rules use `pageRule`; query rules use `defineRule<QueryRule>` with SQL over `pages` / `links` / `hreflang` / `page_resources` / `resources` / `sitemap_urls`. Nothing is loaded whole (hard rule 3).
- Pixel width is a pure function of the stored string and a generated glyph-advance table. A committed script measures that table in Chromium.
- Calibration is a script that crawls the fixture site, plus threshold ladder pages, with both SF and Ariadne, and writes the comparison into the gate doc.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16, drizzle-orm, Playwright Chromium, vitest, Screaming Frog CLI (`/usr/bin/screamingfrogseospider`, gate only).

**Spec:** `docs/superpowers/specs/2026-11-05-phase-26-checks-wave-1-design.md`, the 26a section (owner-approved 2026-11-05, all nine calls). Read it first.

## Global Constraints

- CLAUDE.md hard rules 1–10. Rule 2: no fetch in a rule. Rule 3: every link question is SQL, batched or aggregated in Postgres. Rule 7: a rule that cannot judge says so through a marker, never through silence. Rule 10: checklist ids are written before the rule.
- Baseline: `main` @ `6fa48b3`, ruleset 0.19.0, 114 rules (33 page / 67 query / 14 metric), migrations 0000–0025. Phase 25's gate recorded 92 files / 2,499 tests. Re-run `npm test` at the branch point and record the count.
- **No migration, no schema change, no `EXTRACTION_VERSION` change.**
- **No new API/MCP fields.** New rule ids appear in the existing issue listings.
- Ruleset 0.19.0 → **0.20.0**, once, in Task 2. The version note is built up task by task.
- End state: **154 rules = 49 page + 91 query + 14 metric.** `test/rules/coverage.test.ts` is updated in each task to the running total stated in that task.
- Every new rule needs:
  - copy in `src/rules/registry/copy/issue-copy.ts`, in the shipped register: `Area: Condition` title from the rubric's `AREAS`, one to three sentences, an imperative fix, and any threshold quoted from its constant;
  - `columns` in Screaming Frog vocabulary where one exists;
  - a `` `rule.id` (severity) `` mention in its checklist entry;
  - a positive and a negative DB/unit test;
  - a fixture page in `test/fixtures/pages/authored-p26.ts`, or an entry in `SKIP_HARNESS_CLAIMS` with a paragraph saying why no fixture page can produce it.
- New checklist ids (Task 2): **CHECK-84** security headers, **CHECK-85** mixed content, **CHECK-86** link hygiene. Every other new rule maps to an existing id, as the spec's table says. `resources.bad-content-type` maps to **CHECK-51**, not "new", because broken and wrong-typed resources are one check. The four resource markers already claim CHECK-51, so its silence on an unfetched crawl is explained.
- Categories (closed union, no extension):
  - `security.*` and `resources.bad-content-type` → `technical`, except `security.http-url` → `host`
  - `indexability.nofollow`, `directives.*` → `indexability`
  - `canonical.*` → `canonical`
  - `hreflang.*` → `hreflang`
  - `pagination.*`, `url.*` → `url`
  - `links.*` → `links`
  - `sitemap.*` → `sitemap`
  - pixel rules → `on-page`
- Fixture site: plain HTTP on `127.0.0.1`. New fixtures are `exact: true` and start from the control recipe. If a new rule trips an existing `exact` fixture or the hub, read the page first. If it is a real defect of that page, add the id to its `expectedIssues`. Never loosen the rule to keep a fixture quiet.
- `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`; container `ariadne-pg` (`docker start ariadne-pg`). Chromium is installed.
- Commits are conventional, one per task, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations from the spec text (owner to see in review)

1. **HTTPS-only rules cannot fire on the fixture site.** `security.hsts-missing`, `security.headers-missing`, `security.http-url` and `security.mixed-content` all need HTTPS, and the fixture site is plain HTTP. This is the same limit that already exempts `host.duplicate-host-200`. They go into `SKIP_HARNESS_CLAIMS`, are proven by DB tests, and are checked by hand on the lavishalice re-judge, which is an HTTPS site. SF calibration cannot cover them either.
2. **`security.hsts-missing` and `security.headers-missing` are query rules**, not page rules. A crawl written before Phase 25 has null `response_headers`, and a page rule would read that as "header missing". They call `extractionCoverage(db, crawlId, 1)`. When `below > 0` they return nothing, and a new marker, `security.headers-not-recorded` (info, CHECK-84), fires instead. That is the 40th rule. Mixed crawls get the marker too; the helper's contract is to refuse, not to judge part of a crawl.
3. **`resources.bad-content-type` judges resources only.** The spec says "page or resource". A page whose body is HTML but whose served type is not HTML is classed `non_html` and its body is never kept, so we cannot know it was HTML. That half is unanswerable without sniffing, which is out of scope.
4. **`directives.unavailable-after` is judged against the page's `fetched_at`, not the wall clock**, so re-judging an old crawl gives the same answer. A date that does not parse fires too, with `dateParsed: false`, because Google ignores a directive it cannot parse.
5. **`sitemap.over-50k-urls` counts deduplicated entries.** `sitemap_urls` is keyed on (crawl, url), so a URL listed in two documents counts once. The count is a lower bound until 26c's membership table makes it exact. It can miss a document, but it never fires on one that is under the limit.
6. **Pixel width covers what the glyph table covers:** U+0020–U+052F, U+2000–U+206F and U+20A0–U+20CF. That is Latin, Greek, Cyrillic, punctuation and currency. A title with a character outside the table gets `serpWidth = null`, and the pixel rules do not judge it. The copy says so, and the character-count rules still apply.
7. **`links.localhost` reads external links only** (`is_internal = false`). An internal link is the site itself, so a site crawled on a private address does not report itself.

## Review Focus

1. **A pre-Phase-25 crawl** (every `extraction_version` null) must give `security.headers-not-recorded` and **no** `hsts-missing` / `headers-missing` rows. Never a clean result. (Task 3 test.)
2. **Directive tokens are bounded.** `nofollowing`, `max-snippet:-1`, `max-snippet:50` and `noimageindexer` must not fire. `none` fires `indexability.nofollow`. (Task 4 test.)
3. **Relative and odd spellings resolve before comparison:**
   - A relative canonical chain (`/b` → `/c`) is still a chain.
   - Hreflang codes are compared case-insensitively (`en-GB` = `en-gb`).
   - A trailing-slash variant of the same normalised URL is not "two different targets".
   (Task 5 and Task 6 tests.)
4. **Bounded walks terminate on a cycle of any length:** a canonical loop A→B→C→A and a pagination loop of 3. Each is reported once per member page, with `loop: true` for canonicals, never as a chain that hit the hop cap. (Task 5 and Task 7 tests.)
5. **URL rules look at the path only.** `?utm_source=X` (uppercase, underscore) and `https://Example.com/` (uppercase host) fire nothing. `/a/b/a/b/` is repetitive; `/a/b/c/a/` is not. (Task 9 test.)

---

### Task 1: Thresholds module

**Files:**
- Create: `src/rules/thresholds.ts`
- Modify: `src/rules/page/on-page.ts`, `src/rules/page/technical.ts`, `src/rules/query/link-graph.ts`, `src/rules/query/redirects.ts`, `src/rules/query/content.ts`, `src/rules/query/render-diff.ts`, `src/rules/query/structured-data.ts`, `src/rules/query/resources.ts`, `src/rules/metric/crawl-metrics.ts`
- Test: `test/rules/thresholds.test.ts` (new)

**Interfaces:**
- Produces: `src/rules/thresholds.ts` exports, values unchanged:
  - `TITLE_MIN` 30, `TITLE_MAX` 60, `META_MIN` 70, `META_MAX` 155, `H1_MAX` 70, `URL_MAX` 115, `HEADING_MAX_STEP` 1
  - `SLOW_MS` 1500, `DEEP_DEPTH` 5, `CHAIN_HOPS` 2, `MAX_REDIRECT_HOPS` 10
  - `SOFT_404_WORDS` 300, `THIN_WORDS` 150, `NEAR_DUPLICATE_HAMMING` 3, `NEAR_DUPLICATE_MIN_MAIN_WORDS` 50, `TEMPLATE_HAMMING` 4
  - `CSR_WORD_MULTIPLE` 2, `CSR_MIN_ADDED_WORDS` 150, `NAV_RAW_MAX` 5, `NAV_RENDERED_MIN` 10, `NAV_RENDERED_MULTIPLE` 2, `FILTER_RENDERED_MIN` 5
  - `BREADCRUMB_PAGE_FLOOR` 5, `NONE_PAGE_FLOOR` 1, `IMAGE_WEIGHT_WARN` 100_000, `SITEMAP_URL_CAP` 50_000
- Batch sizes, sample caps and display caps (`*_BATCH`, `*_SAMPLE_*`, `*_CAP` except `SITEMAP_URL_CAP`) are not thresholds and stay where they are.
- Each moved constant keeps its docblock, which moves with it. The old file does `export { X } from "../thresholds.js"`, so every existing import still resolves.

- [ ] **Step 1: Write the failing test.** Name it `thresholds.test.ts` › `"pins every verdict threshold at its Phase 25 value"`. It imports `* as T from "../../src/rules/thresholds.js"` and asserts `expect({...T}).toEqual({ TITLE_MIN: 30, … SITEMAP_URL_CAP: 50_000 })`, the exact 27-key object above. A second test, `"the owning modules re-export the same binding"`, asserts that `onPage.TITLE_MAX === T.TITLE_MAX` and the same for one constant from each modified file.
- [ ] **Step 2:** Run `npx vitest run test/rules/thresholds.test.ts`. Expect FAIL: the module is not found.
- [ ] **Step 3:** Create the module and replace each definition with a re-export.
- [ ] **Step 4:** Run `npx vitest run test/rules && npx tsc --noEmit`. Expect PASS, with `copy.test.ts` unchanged and green.
- [ ] **Step 5:** Commit `refactor(rules): every verdict threshold in src/rules/thresholds.ts`.

### Task 2: Checklist ids, ruleset 0.20.0, fixture scaffold

**Files:**
- Modify: `skills/ariadne-audit/checklist.md`
  - Add `### CHECK-84: Security headers on HTTPS pages` and `### CHECK-85: Mixed content` under section 4.
  - Add `### CHECK-86: Link hygiene (private hosts, generic anchors)` under section 9.
  - Each new entry has `Priority`, `Requires: Engine` and an `Engine` paragraph describing what the check asks. Rule ids are named by the task that registers them, because the identifier guard refuses an unregistered id.
- Modify: `src/rules/registry/registry.ts`: `RULESET_VERSION = "0.20.0"`, with a `// 0.20.0: Phase 26a …` note. The note lists the new rule ids by family and records that `resources.not-recorded` gains CHECK-85. It is extended in each later task.
- Modify: `src/rules/query/resources.ts`: `resources.not-recorded` `checkIds` gains `"CHECK-85"`, because mixed content reads `page_resources` and is silent when the crawl recorded none.
- Create: `test/fixtures/pages/authored-p26.ts` exporting `authoredP26Fixtures: Fixture[] = []`. Register it in `allFixtures()` in `test/fixtures/fixture.ts`.
- Test: `test/skills/identifier-guard.test.ts` and `test/rules/coverage.test.ts`, existing.

- [ ] **Step 1:** Add the three CHECK entries.
- [ ] **Step 2:** Bump the version, change the checkIds on `resources.not-recorded`, add the empty fixture module, and add `"CHECK-85"` to `resources.not-recorded`'s entry in the section-12 claims pin in `coverage.test.ts`.
- [ ] **Step 3:** Run `npx vitest run test/rules test/skills && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 4:** Commit `docs(checklist): CHECK-84..86 for phase 26a; ruleset 0.20.0`.

### Task 3: Security and served-type rules (5 rules + 1 marker)

**Files:**
- Create: `src/rules/query/security.ts` exporting `securityRules: QueryRule[]` (5 rules: hsts, headers, the marker, http-url, mixed content)
- Modify: `src/rules/query/resources.ts`: add `resources.bad-content-type` to `resourceRules`
- Modify: `src/rules/thresholds.ts`: add `UNSAFE_REFERRER_POLICIES = ["unsafe-url", "no-referrer-when-downgrade"] as const`
- Modify: `src/rules/index.ts` (register), `issue-copy.ts`, checklist (CHECK-84, CHECK-85, CHECK-51, CHECK-14 and CHECK-83 entries)
- Modify: `test/fixtures/harness.test.ts`: add the 5 HTTPS/marker ids to `SKIP_HARNESS_CLAIMS`, with one paragraph covering the four HTTPS rules (deviation 1) and one for the marker (same shape as `content.thin-skipped`)
- Test: `test/rules/security-query.test.ts` (new); `test/rules/resources-query.test.ts`

**Interfaces:**
- Produces, in `src/rules/query/security.ts`:
  - `export function missingSecurityHeaders(h: StoredResponseHeaders): { missing: string[]; referrerPolicy: string | null }`. This is the pure core. `missing` contains, in this order and only when absent:
    - `"content-security-policy"`. `content-security-policy-report-only` does not count.
    - `"x-content-type-options"`. Present only when the value is `nosniff`, case-insensitive.
    - `"frame-protection"`. Satisfied by `x-frame-options` `DENY`/`SAMEORIGIN`, or by a CSP containing `frame-ancestors`.
    - `"referrer-policy"`. Missing, or the last token is in `UNSAFE_REFERRER_POLICIES`. `referrerPolicy` carries the unsafe value when there is one, otherwise null.
- Rule semantics. "Cohort" means `isAuditable` pages (fetched OK, 200, HTML) whose `url` starts with `https:`.

| Rule | Severity / checkIds | Fires on | Evidence keys (columns) |
|---|---|---|---|
| `security.hsts-missing` | warning / CHECK-84 | cohort page whose `response_headers.values` has no `strict-transport-security` | none (empty columns) |
| `security.headers-missing` | info / CHECK-84 | cohort page where `missingSecurityHeaders(...).missing` is non-empty | `missing` "Missing Headers", `referrerPolicy` "Referrer-Policy" (optional) |
| `security.headers-not-recorded` | info / CHECK-84, `marker` | `extractionCoverage(db, crawlId, 1).below > 0` and there is at least one cohort page. One site finding, `dedupeKey` `"site"` | `pagesNotRecorded`, `pagesRecorded` |
| `security.http-url` | warning / CHECK-14 | `crawls.site_url` is `https:` and an `isAuditable` page's `url` is `http:` | none |
| `security.mixed-content` | warning / CHECK-85 | cohort page with a `page_resources.resource_url` starting `http:`. One finding per page | `insecureCount` "Insecure Resources", `sample` (≤ `BROKEN_SAMPLE_RESOURCES` urls, ordered) "Insecure Resource URLs" |
| `resources.bad-content-type` | info / CHECK-51 | a `resources` row with `status_code` 200 whose `content_type` (before `;`, lower-cased) contradicts its `kind`: css not `text/css`; js not in {`text/javascript`, `application/javascript`, `application/x-javascript`, `application/ecmascript`, `text/ecmascript`, `module`}; image not `image/*`. One finding per resource, filed like `resources.broken`, with up to `BROKEN_SAMPLE_RESOURCES` referencing pages | `resourceUrl`, `kind`, `contentType`, `pageCount`, `samplePages` |

- `hsts-missing` and `headers-missing` both start with the coverage check. When `below > 0` they return `[]`.

- [ ] **Step 1: Write failing tests** in `security-query.test.ts`, using the `newCrawl`/`createdCrawls` house pattern from `pagination-query.test.ts`:
  - `missingSecurityHeaders` cases:
    - all present → `[]`
    - report-only CSP → includes `"content-security-policy"`
    - `x-content-type-options: NOSNIFF` → not missing
    - XFO absent but CSP has `frame-ancestors 'self'` → no `"frame-protection"`
    - `referrer-policy: unsafe-url` → missing includes it, `referrerPolicy: "unsafe-url"`
  - Pre-25 crawl: two https pages with `extractionVersion: null` → marker fires with `{pagesNotRecorded: 2, pagesRecorded: 0}`; `hsts-missing` and `headers-missing` return `[]`.
  - Current crawl (`extractionVersion: 1`), https page without HSTS → one `hsts-missing`. An `http:` page on an `http:` site → nothing from any security rule. An `http:` page on an `https:` site → `security.http-url`.
  - Mixed content: an https page with resources `http://x/a.jpg` and `https://x/b.jpg` → `insecureCount: 1`.
  - In `resources-query.test.ts`: a css resource served `text/html; charset=utf-8` fires. A js resource served `application/javascript; charset=utf-8` does not. A 404 css never fires; that is `resources.broken`'s job.
- [ ] **Step 2:** Run `npx vitest run test/rules/security-query.test.ts test/rules/resources-query.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. `security.mixed-content` aggregates in SQL (`count(*) filter`, `array_agg(... order by resource_url) [1:N]`), never per-row in JS.
- [ ] **Step 4:** Add copy, checklist mentions and the CHECK-83 marker line. Update `coverage.test.ts` to **120 = 33 page + 73 query + 14 metric**, and its section-12 pin (`resources.bad-content-type` claims CHECK-51). Add the five ids to `SKIP_HARNESS_CLAIMS` with their paragraphs. `resources.bad-content-type` is not exempt: add a fixture whose stylesheet the fixture app serves as `text/html`. Use the existing asset helpers in `test/fixtures/assets.ts`.
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS, 0 skipped.
- [ ] **Step 6:** Commit `feat(rules): security headers, mixed content, wrong-typed resources (26a)`.

### Task 4: Directive rules (3 page rules)

**Files:**
- Modify: `src/rules/helpers.ts`. Add `export function robotsTokens(value: string | null): string[]`: split on commas, lower-case, trim, and drop a leading `<bot>:` prefix from a token. The prefix is ignored, consistent with `saysNoindex`; bot-specific directives are 26b's job. `unavailable_after: <date>` is kept as one token whose date part contains colons and commas. Parse it first with `/unavailable_after:\s*([^,]+(?:,[^,:]+)?)/i`, then tokenise the rest.
- Create: `src/rules/page/directives.ts` exporting `directiveRules: PageRule[]`
- Modify: `src/rules/thresholds.ts`: `UNAVAILABLE_AFTER_WARN_DAYS = 30`, `RESTRICTIVE_DIRECTIVES = ["nosnippet", "max-snippet:0", "max-image-preview:none", "noimageindex"] as const`
- Test: `test/rules/directives.test.ts` (new), using `mkPage` and `expectSilentOnNonOkFetches` from `test/rules/mk-page.ts`

**Interfaces:**
- Gate: `isAuditable(p)`. These are facts about any served page, as `indexability.noindex` is.

| Rule | Severity / checkIds | Fires on | Evidence |
|---|---|---|---|
| `indexability.nofollow` | warning / CHECK-04 | `nofollow` or `none` token in `robotsMeta` or `xRobotsTag` | `source` ("meta" / "header" / "both"), `robotsMeta`, `xRobotsTag` |
| `directives.restrictive` | warning / CHECK-04 | any token in `RESTRICTIVE_DIRECTIVES`. `max-snippet:0` is matched exactly, so `max-snippet:-1` does not fire | `directives` (matched tokens, in order found) |
| `directives.unavailable-after` | warning / CHECK-04 | date parsed with `Date.parse` is `< fetchedAt + 30 days`, or the date is unparseable. Pages with null `fetchedAt` are never judged; a fetched-OK page always has one | `unavailableAfter` (raw), `dateParsed` (bool), `daysFromFetch` (int, optional) |

- [ ] **Step 1:** Write failing tests. Include Review Focus 2 exactly. Add `unavailable_after: 25 Jun 2010 15:00:00 PST` → fires with `daysFromFetch` negative. A date 31 days after `fetchedAt` → silent; 29 days → fires. `unavailable_after: soon` → fires, `dateParsed: false`.
- [ ] **Step 2:** Run `npx vitest run test/rules/directives.test.ts test/rules/helpers.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Copy, CHECK-04 mentions, and three fixtures:
  - `/p26/nofollow` with `<meta name=robots content="index, nofollow">`
  - `/p26/nosnippet` with `nosnippet`
  - `/p26/unavailable-after` with a 2010 date
  - The nofollow fixture also fires nothing else. Check it against `exact`.
  - Coverage: **123 = 36 page + 73 query + 14 metric**.
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit `feat(rules): nofollow, restrictive and unavailable_after directives (26a)`.

### Task 5: Canonical rules (2 page + 2 query)

**Files:**
- Modify: `src/rules/page/canonical.ts`: add `canonical.relative` and `canonical.fragment` to `canonicalRules`
- Create: `src/rules/query/canonical-graph.ts` exporting `canonicalGraphRules: QueryRule[]`
- Modify: `src/rules/thresholds.ts`: `CANONICAL_MAX_HOPS = 10`
- Test: `test/rules/canonical.test.ts` (extend), `test/rules/canonical-graph-query.test.ts` (new)

**Interfaces:**
- Consumes: `resolveEffectiveCanonical`, `isCanonicalisedElsewhere`, `JUDGED`, `ROBOTS_BLOCKED` from `src/rules/helpers.ts`.

| Rule | Severity / checkIds | Gate | Fires on | Evidence |
|---|---|---|---|---|
| `canonical.relative` | info / CHECK-16 | `isAuditable` | `canonicalHtml` present and `!/^[a-z][a-z0-9+.-]*:/i.test(value)` | `canonical` "Canonical Link Element" |
| `canonical.fragment` | warning / CHECK-16 | `isAuditable` | the effective canonical (`effectiveCanonical`) contains `#` | `canonical` |
| `canonical.chain` | warning / CHECK-17, CHECK-19 | auditable pages canonicalised elsewhere | the target page exists, is auditable, and is itself canonicalised elsewhere. Walk ≤ `CANONICAL_MAX_HOPS` | `canonical`, `hops` (url list, starting at the target), `loop` (bool), `hopLimitReached` (optional) |
| `canonical.unlinked` | info / CHECK-17 | `JUDGED` pages canonicalised elsewhere whose target is a crawled page | no `links` row with `target_url = target.url`, `is_internal`, and `source_page_id <> target.id` | `canonical` |

- `canonical.chain` walks one hop per round per batch. Take a batch of `CANONICAL_BATCH` pages, resolve their targets in JS, then fetch the target rows in one `= any(...)` query. Repeat with the targets still canonicalising elsewhere, up to `CANONICAL_MAX_HOPS` rounds. Memory is O(batch × hops), never O(site).
- A loop is reported with `loop: true` and is not also counted as a hop-limit chain.

- [ ] **Step 1:** Write failing tests: relative `/x` fires `relative`, absolute does not; `https://s/x#top` fires `fragment`; A→B→C chain gives `hops: [B, C]`; Review Focus 3 and 4 cases; a page linked only from itself counts as unlinked.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Copy, mentions and fixtures:
  - `/p26/canonical-relative`
  - `/p26/canonical-fragment`
  - `/p26/chain-a` → `/p26/chain-b` → `/p26/chain-c`, where c is self-canonical and none is linked from the hub except a
  - Coverage: **127 = 38 page + 75 query + 14 metric**.
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit `feat(rules): relative, fragment, chained and unlinked canonicals (26a)`.

### Task 6: Hreflang integrity (4 query rules)

**Files:**
- Create: `src/rules/query/hreflang-integrity.ts` exporting `hreflangIntegrityRules: QueryRule[]`. `hreflang.ts` is 937 lines, so these go in their own file.
- Test: `test/rules/hreflang-integrity-query.test.ts` (new)

**Interfaces:**
- Cohort: hreflang rows of auditable pages (`source = 'html'` today; 26c widens). Codes are compared with `lower()`. Targets are compared on `url_match_key` (`URL_MATCH_KEY`). Batch by page, as `HREFLANG_PAGE_BATCH` does.

| Rule | Severity / checkIds | Fires on | Evidence |
|---|---|---|---|
| `hreflang.inconsistent-return-code` | warning / CHECK-24 | A lists (X → B); B lists a return link to A with code Y; A's self-reference code is Z; Y ≠ Z. No self-reference on A means no judgement here; `missing-self-reference` owns that case | `hreflang` (X), `target` (B), `returnCode` (Y), `selfCode` (Z) |
| `hreflang.multiple-entries` | warning / CHECK-24 | one page lists one code for ≥ 2 distinct match keys | `hreflang`, `targets` (sorted) |
| `hreflang.self-only` | info / CHECK-24 | every hreflang row of the page targets the page itself (≥ 1 row) | `hreflang` (codes, sorted) |
| `hreflang.unlinked-target` | info / CHECK-24 | a target that is a crawled internal page with no internal `<a>` inlink from another page. One finding per target, filed on the target | `sources` (≤ `SAMPLE_SOURCES` declaring pages), `sourceCount` |

- [ ] **Step 1:** Write a failing test for each rule, positive and negative, including Review Focus 3.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Copy, mentions and fixtures. Extend the existing hreflang fixture set's pattern: one cluster with a wrong return code, one page with duplicate `en`, one self-only page, and one alternate linked only by hreflang. Update the harness test `"the hreflang fixtures' declarations reach the rules that judge them"` if its expected set is exact. Coverage: **131 = 38 page + 79 query + 14 metric**.
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit `feat(rules): hreflang return-code, duplicate, self-only and unlinked targets (26a)`.

### Task 7: Pagination (3 query rules)

**Files:**
- Modify: `src/rules/query/pagination.ts`: add the three rules to `paginationRules`
- Modify: `src/rules/thresholds.ts`: `PAGINATION_WALK_MAX = 500`
- Test: `test/rules/pagination-query.test.ts`. Its metadata test pins "exactly the three"; it becomes the six.

| Rule | Severity / checkIds | Fires on | Evidence |
|---|---|---|---|
| `pagination.non-indexable-target` | warning / CHECK-22, CHECK-23 | `rel=next` or `rel=prev` resolves to a crawled page that is not 200 or carries noindex (`hasNoindex`). Uncrawled targets stay `next-target-uncrawled`'s | `rel` ("next"/"prev"), `target`, `targetStatus`, `targetNoindex` |
| `pagination.loop` | warning / CHECK-22 | a page in a `rel=next` cycle. Detected in SQL with a recursive CTE over `(page, resolved next)` using Postgres `CYCLE … SET is_cycle`, depth ≤ `PAGINATION_WALK_MAX`. The resolved-next keys come from `normalizeUrl` in JS, written per batch into a temp table or a `values` list; never the whole site in one array | `cycle` (urls in walk order, ≤ 20) |
| `pagination.sequence-error` | info / CHECK-22 | A.next = B (crawled, auditable), and B's `relPrev` is null or does not resolve to A | `next` (B), `nextsPrev` (B's raw rel=prev or null) |

- [ ] **Step 1:** Write failing tests, including Review Focus 4: a 3-cycle gives 3 findings, each with the same `cycle` set. A straight 3-page series with correct prevs gives none. A series where page 2 has no prev → `sequence-error` on page 1.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Copy, mentions, fixtures (`/p26/loop-1..3`, a 404 next target, a broken prev). Check the harness test `"the paginated series proves all three pagination rules"`: if the existing series trips `sequence-error`, that is a real defect of the fixture, so add the id. Coverage: **134 = 38 page + 82 query + 14 metric**.
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit `feat(rules): pagination targets, loops and sequence errors (26a)`.

### Task 8: Link hygiene (5 query rules)

**Files:**
- Create: `src/rules/query/link-hygiene.ts` exporting `linkHygieneRules: QueryRule[]`
- Modify: `src/crawl/url-policy.ts`: export `BLOCKED_HOSTS` and `BLOCKED_HOST_SUFFIXES` (as `readonly`) so the SQL prefilter is built from the same lists. `blockedHostReason` stays the deciding authority.
- Modify: `src/rules/thresholds.ts`:
  - `NON_DESCRIPTIVE_ANCHORS` (English, lower-case, compared after trim and collapsing whitespace): `click here`, `click`, `here`, `read more`, `more`, `learn more`, `find out more`, `continue reading`, `continue`, `see more`, `view more`, `more info`, `more information`, `details`, `this page`, `this`, `link`, `go`, `website`
  - `HIGH_INTERNAL_OUTLINKS = 1000` and `HIGH_EXTERNAL_OUTLINKS = 100`, documented as starting values that Task 12 replaces with the calibrated values
- Test: `test/rules/link-hygiene-query.test.ts` (new)

| Rule | Severity / checkIds | Source cohort | Fires on | Evidence |
|---|---|---|---|---|
| `links.internal-nofollow` | warning / CHECK-33 | auditable pages | ≥ 1 internal link with `is_nofollow` | `nofollowCount`, `sample` (≤ `SAMPLE_SOURCES` distinct targets) |
| `links.only-from-non-indexable` | warning / CHECK-32 | `JUDGED` target pages | ≥ 1 internal inlink from another page, and none of those sources is `JUDGED` | `inlinkSources` (count), `sample` |
| `links.localhost` | warning / CHECK-86 | auditable pages | an external link whose host passes the SQL prefilter (IP literal, `[`-bracketed, dotless, in `BLOCKED_HOSTS`, or ending in a `BLOCKED_HOST_SUFFIXES` entry) and `blockedHostReason(host) !== null` in JS | `targets` (≤ 10), `reason` (first target's) |
| `links.non-descriptive-anchor` | info / CHECK-86 | auditable pages | internal links whose normalised anchor is in the list | `anchors` (distinct, ≤ 10), `count` |
| `links.high-outlinks` | info / CHECK-33 | auditable pages | `count(distinct target_url)` internal > `HIGH_INTERNAL_OUTLINKS`, or external > `HIGH_EXTERNAL_OUTLINKS` | `internalOutlinks`, `externalOutlinks`, `max` (the threshold crossed) |

- All per-page aggregation runs in Postgres (`group by source_page_id`) with keyset batching on page id. The links table is never loaded (hard rule 3).

- [ ] **Step 1:** Write failing tests for each rule, positive and negative:
  - `http://localhost:3000/x` external fires; `http://192.168.1.4/` fires; `https://example.com/` does not.
  - `"Read  More"` fires (case and whitespace normalised); `"read more about pricing"` does not.
  - Exactly `HIGH_INTERNAL_OUTLINKS` distinct targets → silent; one more → fires.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Copy, mentions and fixtures:
  - a page with `rel=nofollow` internal links
  - a page linked only from a noindex page
  - a page linking `http://10.1.2.3/admin`
  - a page with a "click here" internal link
  - a page with `HIGH_INTERNAL_OUTLINKS + 1` generated internal links to its own `?n=` variants (generated in the fixture, not hand-written)
  - Coverage: **139 = 38 page + 87 query + 14 metric**.
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit `feat(rules): link hygiene — nofollow, non-indexable-only inlinks, private hosts, generic anchors, outlink volume (26a)`.

### Task 9: URL shape (7 page rules)

**Files:**
- Create: `src/rules/page/url-shape.ts` exporting `urlShapeRules: PageRule[]`
- Modify: `src/rules/thresholds.ts`: `INTERNAL_SEARCH_PARAMS = ["s", "q", "query", "search", "keyword", "keywords"] as const` and `INTERNAL_SEARCH_PATH = /(?:^|\/)search(?:\/|$)/i`
- Test: `test/rules/url-shape.test.ts` (new)

**Interfaces:**
- Gate: `isJudged(p)`, as `url.too-long` uses. Read `new URL(p.url).pathname` raw; it is percent-encoded as stored.

| Rule | Severity | Fires when the pathname… | Evidence |
|---|---|---|---|
| `url.uppercase` | info | has `[A-Z]` | `path` |
| `url.underscores` | info | contains `_` | `path` |
| `url.non-ascii` | info | has a char > U+007F, or `%[89A-F][0-9A-F]` (encoded byte ≥ 0x80) | `path` |
| `url.spaces` | warning | contains `%20`, `+`, or a literal space | `path` |
| `url.multiple-slashes` | warning | contains `//` | `path` |
| `url.repetitive-path` | warning | for some segment run of length L ≥ 1, segments[i..i+L) equal segments[i+L..i+2L) (empty segments ignored) | `path`, `repeated` (the run, joined with `/`) |
| `url.internal-search` | warning, CHECK-67 | matches `INTERNAL_SEARCH_PATH`, or the query has a key in `INTERNAL_SEARCH_PARAMS` | `path`, `param` (optional) |

- All rules except `url.internal-search` are CHECK-30.

- [ ] **Step 1:** Write failing tests, including Review Focus 5 exactly. Add: `/café` and `/caf%C3%A9` fire `non-ascii`; `/a//b` fires `multiple-slashes`; `/?s=shoes` fires `internal-search`; `/search-tips` does not.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Copy, mentions and one fixture per rule (`/p26/Upper-Case`, `/p26/under_score`, `/p26/caf%C3%A9`, `/p26/with%20space`, `/p26//double`, `/p26/shop/shop/x`, `/search?q=x` served as an indexable page). Existing fixture paths that trip these rules get the id added when it is a real property of that URL. Coverage: **146 = 45 page + 87 query + 14 metric**.
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit `feat(rules): URL shape — case, underscores, non-ASCII, spaces, slashes, repetition, internal search (26a)`.

### Task 10: Sitemap entries (4 query rules)

**Files:**
- Create: `src/rules/query/sitemap-entries.ts` exporting `sitemapEntryRules: QueryRule[]`. Each rule opens with `readCrawlEvidence` (the crawl-exists check, and the discovery gate the other sitemap rules use).
- Modify: `src/rules/thresholds.ts`: `SITEMAP_LOC_MAX = 2048`, and `W3C_DATETIME`, the six W3C-DTF forms (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `YYYY-MM-DDThh:mmTZD`, `…:ss`, `…:ss.s+`), as one anchored regex
- Modify: `test/fixtures/app.ts`: the sitemap writer emits `<lastmod>` when a fixture sets a new optional `sitemapLastmod?: string` field on `Fixture`
- Test: `test/rules/sitemap-entries-query.test.ts` (new)

| Rule | Severity / checkIds | Fires on | Evidence |
|---|---|---|---|
| `sitemap.over-50k-urls` | warning / CHECK-08 | a `sitemap_source` with `count(*) > SITEMAP_URL_CAP`. One finding per document, `pageId` null, `dedupeKey` = source. The count is a lower bound (deviation 5); say so in copy | `sitemap`, `entries` |
| `sitemap.url-too-long` | info / CHECK-07 | `length(url) > SITEMAP_LOC_MAX` | `sitemap`, `loc` (first 200 chars), `length` |
| `sitemap.cross-host-loc` | warning / CHECK-07 | the scheme or host of `url` differs from the scheme or host of `sitemap_source` (compared in SQL on the `^[a-z]+://[^/]+` prefix, lower-cased) | `sitemap`, `loc` |
| `sitemap.lastmod-invalid` | info / CHECK-07 | `lastmod` is not null and fails `W3C_DATETIME`, or parses to after `crawls.started_at` | `sitemap`, `loc`, `lastmod`, `reason` ("format" / "future") |

- Listing rules spend `caps.listing` and call `noteTruncation`, as the other listing rules do.

- [ ] **Step 1:** Write failing tests. A 50,001-entry source: insert it with `generate_series` in SQL, never a JS array. Also: a 2,049-char loc, an `http://other.example/x` loc in an `https://site/sitemap.xml`, and lastmods `2026-13-01` (format), `2999-01-01` (future) and `2026-11-04T10:00:00+00:00` (valid).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Copy (including `SITEMAP_URL_CAP` and `SITEMAP_LOC_MAX` quoted against constants in `copy.test.ts`), mentions, fixtures:
  - one entry with a bad lastmod
  - one fixture whose `sitemapLoc` is on `legacyBase` (cross-host)
  - one fixture with a `sitemapLoc` over 2,048 chars
  - Update `"the site-scoped findings are …"` and `"the sitemap's deliberate mistakes land on the URLs that carry them"` in the harness.
  - `sitemap.over-50k-urls` → `SKIP_HARNESS_CLAIMS`, with a paragraph: a 50,001-entry fixture sitemap would put 50k URLs into the fixture crawl's frontier.
  - Coverage: **150 = 45 page + 91 query + 14 metric**.
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit `feat(rules): sitemap entry limits, cross-host locs and invalid lastmod (26a)`.

### Task 11: SERP glyph table and `serpWidth`

**Files:**
- Create: `scripts/measure-serp-glyphs.ts`:
  - Launches Playwright Chromium headless and sets canvas `ctx.font = "20px Arial"` (title) and `"14px Arial"` (description), with `ctx.fontKerning = "none"`.
  - Measures `measureText(ch).width` for every code point in the three ranges (deviation 6), rounded to 3 decimals.
  - Before measuring, renders a `<span style="font: 20px Arial">` and reads `CSS.getPlatformFontsForNode` over CDP. If the family is not `Arial` or `Liberation Sans` (metric-compatible), it **throws**; there is no fallback font.
  - Writes `src/rules/serp-glyphs.generated.ts`.
- Create: `src/rules/serp-glyphs.generated.ts` (generated and committed). It opens with a provenance header comment: the script, the Chromium revision, the resolved platform font, the date, and "advance sum, kerning off". It exports `SERP_GLYPHS: { title: Record<number, number>; description: Record<number, number> }`.
- Create: `src/rules/serp-width.ts`: `export function serpWidth(text: string, kind: "title" | "description"): number | null`. This is the sum of advances by code point (`for…of`), rounded to 1 decimal. It returns `null` if any code point is missing from the table.
- Test: `test/rules/serp-width.test.ts` (new)

- [ ] **Step 1:** Write failing tests:
  - `serpWidth("", "title") === 0`
  - `serpWidth("WWW","title") > serpWidth("iii","title")`
  - the description width of `"abc"` ≈ the title width × 0.7 within 0.5px
  - `serpWidth("日本", "title") === null`
  - **re-measure:** launch Chromium, as the harness does, measure 20 fixed sample strings with the same canvas settings, and assert `serpWidth` is within 0.5px of each. This proves the committed table matches this machine's font.
- [ ] **Step 2:** Run `npx vitest run test/rules/serp-width.test.ts`. Expect FAIL.
- [ ] **Step 3:** Write the script, run `npx tsx scripts/measure-serp-glyphs.ts`, and write `serp-width.ts`.
- [ ] **Step 4:** Run the test. Expect PASS. Also run `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(rules): SERP glyph advances measured in Chromium, serpWidth`.

### Task 12: Pixel-width rules (4 page rules)

**Files:**
- Create: `src/rules/page/pixel-width.ts` exporting `pixelWidthRules: PageRule[]`
- Modify: `src/rules/thresholds.ts`: `TITLE_PX_MAX = 561`, `TITLE_PX_MIN = 200`, `META_PX_MAX = 985`, `META_PX_MIN = 400`, documented as starting values that Task 13's calibration confirms or moves
- Test: `test/rules/pixel-width.test.ts` (new)

| Rule | Severity / checkIds | Fires on (gate `isJudged`, value present, `serpWidth` non-null) | Evidence |
|---|---|---|---|
| `title.pixel-too-long` | warning / CHECK-35 | width > `TITLE_PX_MAX` | `title` "Title 1", `pixelWidth` "Title 1 Pixel Width", `max` |
| `title.pixel-too-short` | info / CHECK-35 | width < `TITLE_PX_MIN` | `title`, `pixelWidth`, `min` |
| `meta-description.pixel-too-long` | warning / CHECK-36 | width > `META_PX_MAX` | `metaDescription` "Meta Description 1", `pixelWidth` "Meta Description 1 Pixel Width", `max` |
| `meta-description.pixel-too-short` | info / CHECK-36 | width < `META_PX_MIN` | `metaDescription`, `pixelWidth`, `min` |

- [ ] **Step 1:** Write failing tests:
  - a title built from the table to land exactly on `TITLE_PX_MAX` → silent; one glyph wider → fires
  - an all-CJK title → silent from all pixel rules, while `title.too-long` still fires on its character count
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:**
  - Copy: titles quote pixel bounds checked against constants in `copy.test.ts`; explanations say characters outside the measured scripts are not pixel-judged.
  - Mentions and four fixtures.
  - Coverage: **154 = 49 page + 91 query + 14 metric** (final).
- [ ] **Step 5:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 6:** Commit `feat(rules): title and meta description pixel width (26a)`.

### Task 13: SF calibration

**Files:**
- Create: `test/fixtures/pages/calibration-p26.ts` exporting `calibrationFixtures(): Fixture[]`. These are threshold ladders and are **not** in `allFixtures()`:
  - **title px:** 12 pages at 150…600 px in even steps, built from the glyph table
  - **description px:** 12 pages at 300…1,050 px
  - **outlinks:** internal 50, 100, 150, 200, 300, 500, 750, 1,000, 1,001; external 10, 25, 50, 75, 100, 101
  - **response time:** the handler delays 250, 500, 1,000, 1,500, 2,000, 3,000 ms
  - **click depth:** a chain 1…10 deep
- Create: `scripts/calibrate-sf.ts`, which:
  1. `startFixtureApp([...allFixtures(), ...calibrationFixtures()])`
  2. runs SF: `screamingfrogseospider --crawl <base>/ --headless --output-folder <scratch> --export-format csv --overwrite --export-tabs "<list>"`. The tab:filter list is built from a `SF_FILTERS` table in the script mapping each SF filter name to our rule id(s) and the 26a family. Confirm the exact filter names against `screamingfrogseospider --help` and the local `sf-cli` skill reference, and refuse to run if any listed filter produced no file.
  3. runs `runCrawl` + `runRules` over the same base, as `harness.test.ts` does
  4. writes `docs/gates/phase-26a-calibration.md`: per mapped filter, the URLs in both, SF only, and Ariadne only; per ladder, the first rung each tool flags
- Modify: `src/rules/thresholds.ts`, only where a ladder shows SF's boundary for a threshold the spec calls unknown (high outlinks, pixel bounds, slow response, click depth). Each changed value gets a docblock line: `calibrated against Screaming Frog <version> defaults, 2026-11-xx (docs/gates/phase-26a-calibration.md)`. `THIN_WORDS` stays at 150 unless the run gives a reason.
- If a threshold moved, update the copy, `thresholds.test.ts` pins and any boundary fixtures in the same commit.

- [ ] **Step 1:** Write the ladder fixtures and the script.
- [ ] **Step 2:** Run `DATABASE_URL=… npx tsx scripts/calibrate-sf.ts`. Expect the report written, with every mapped filter accounted for.
- [ ] **Step 3:** For every divergence, write the reason into the report. "Ours is template-aware" is a reason; "not looked at" is not. Fix any divergence that is our bug, with a test in the owning task's test file.
- [ ] **Step 4:** Apply the calibrated thresholds. Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `chore(gate): SF black-box calibration for 26a; thresholds from the ladders`.

### Task 14: Surfaces and the 26a gate

**Files:**
- Modify: `docs/talos-surface.md` (the rules/issue listing section), `skills/ariadne-audit/SKILL.md` and `skills/ariadne-report/SKILL.md`: name the 40 new ids where their family is described. The identifier guard checks every name.
- Create: `docs/gates/phase-26a.md`, with the same clause table shape as `docs/gates/phase-25.md`:
  1. Full suite: N files / M tests, 0 skipped; `tsc` clean.
  2. Positive and negative tests per rule. Fixture coverage, with `SKIP_HARNESS_CLAIMS` growing by six and each one argued.
  3. A calibration summary that links `phase-26a-calibration.md`.
  4. Re-judge the stored lavishalice crawl `crawl_11e15602-63c4-4aa4-8b94-fb3b65908f19` through `ApiService.runRulesForCrawl` (MCP `crawl_rules`), with no re-crawl:
     - Give a table of the finding count per new rule.
     - Hand-check a sample of up to 5 findings per rule against the live page.
     - Name every false positive and either fix it or write the reason it stays.
     - The four HTTPS rules get their manual check here (deviation 1).

- [ ] **Step 1:** Update the surfaces. Run `npx vitest run test/skills`. Expect PASS.
- [ ] **Step 2:** Run the re-judge and write the gate doc.
- [ ] **Step 3:** Run `npm test && npx tsc --noEmit`. Expect PASS, 0 skipped.
- [ ] **Step 4:** Commit `docs: phase-26a gate`.

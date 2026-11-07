# Phase 26b: One parser wave — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add every 26b parser fact in one extraction bump (`EXTRACTION_VERSION` 2, one migration) and build 25 rules plus one NOT MEASURED marker on them. Revise the five existing rules the spec names. Ruleset 0.21.0. End with a lavishalice re-crawl gate covering memory, row size and false positives.

**Architecture:**
- New page facts come from the existing streaming analyzer (`src/crawl/parse/page-analyzer.ts`, htmlparser2 callbacks and state, never a DOM). They are stored in new **nullable** `pages` columns, so a row written before the bump reads null ("not measured"), never zero.
- Fact types, caps and the pure `parseRefresh` live in one new module, `src/crawl/parse/page-facts.ts`, which both the analyzer and the rules import.
- Page rules read the new columns and stay silent on null.
- Query rules that need v2 facts call `extractionCoverage(db, crawlId, 2)` and refuse the crawl when `below > 0`. One new query marker, `extraction.not-recorded`, says so for the whole crawl.
- og/X images become `resources` rows (so the resource pass fetches their status and size) but never `page_resources` rows, because a browser does not load them.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16, drizzle-orm + drizzle-kit, htmlparser2 (hot path), cheerio (test oracle only), vitest, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-11-05-phase-26-checks-wave-1-design.md`, the 26b section (owner-approved 2026-11-05). Read it first. Read the 26a plan (`docs/superpowers/plans/2026-11-05-phase-26a-rules-over-existing-data.md`) Global Constraints for house conventions; this plan repeats the ones that bind.

## Global Constraints

- CLAUDE.md hard rules 1–10.
  - Rule 4 is central: every new fact is collected in the streaming tokenizer as state. No DOM, no second parse.
  - Rule 6: every new fact is capped. Per-page memory stays O(1) in page size beyond the existing caps.
  - Rule 7: a rule that cannot judge says so through a marker, never through silence that reads as a pass.
- User rule: no fallbacks. A missing aggregate row throws; `?? 0` only where an empty result truly means zero matches (the `noteTruncation` total).
- Baseline: `main` @ `4a993ef` (PR #22 merge), ruleset 0.20.0, 154 rules (49 page / 91 query / 14 metric), migrations 0000–0025, `EXTRACTION_VERSION` 1, **104 files / 2,859 tests green** (measured on this branch at its creation, with `DATABASE_URL` set).
- **One migration, `0026`** (drizzle-kit generated, `npm run db:generate`; never hand-written SQL), in Task 1. **`EXTRACTION_VERSION` 1 → 2**, once, in Task 1.
- **No new API/MCP fields.** New rule ids appear in the existing issue listings.
- Ruleset 0.20.0 → **0.21.0**, once, in Task 1. The version note is built up task by task, in the house style (`// 0.21.0: Phase 26b, …` block; numbered items `(Tn)`).
- End state: **180 rules = 69 page + 97 query + 14 metric; severities 33 critical / 62 warning / 85 info.** Each task updates the count pins to the running totals it states:
  - `test/rules/coverage.test.ts` (the split pin and its narrative comment)
  - `test/rules/registry.test.ts` (count and severity split)
  - `test/rules/run.test.ts` (id count)
- Every new rule needs:
  - copy in `src/rules/registry/copy/issue-copy.ts` that satisfies `test/rules/copy.test.ts`: an `Area: Condition` title from `AREAS`, an explanation of one to three sentences, an imperative fix, and any threshold quoted from its constant (add ids matching the `:1901` guard to `THRESHOLD_IN_TITLE`);
  - `columns` in Screaming Frog vocabulary where one exists; every evidence key declared, optional ones marked `optional: true`;
  - a `` `rule.id` (severity) `` mention in its checklist entry;
  - a positive and a negative DB or unit test;
  - a fixture page in `test/fixtures/pages/authored-p26b.ts`, or an entry in `SKIP_HARNESS_CLAIMS` with a paragraph saying why no fixture page can produce it.
- Page rules on a v2 fact gate on `isJudged` (on-page, social and image facts) or `isAuditable` (directives, refresh, links, security, structure). They fire only on a non-null column. A test per rule proves a `mkPage` row with that column null (a v1 row) is silent.
- Every query rule on a v2 fact starts with `extractionCoverage(db, crawlId, 2)`. When `below > 0` it returns `[]` (the marker speaks). It uses the 26a idioms:
  - SQL only
  - `limitTo(caps.listing)` with `count(*) over ()` and `noteTruncation`, or `cappedListing` for batched scans
  - `assertCrawl` before concluding anything from an empty scan
- New checklist ids, both in Task 1:
  - **CHECK-87** Social sharing tags (Open Graph and X)
  - **CHECK-88** HTML document structure
- Other mappings (deviation 8):
  - `links.empty-href`, `links.no-anchor-text` and `links.unsafe-target-blank` → **CHECK-86** (link hygiene)
  - `security.form-insecure` → **CHECK-85** (its title widens to "Mixed content and insecure forms")
  - every other rule → the id in the spec's table
- Categories (closed union; do not extend):

  | Rules | Category |
  |---|---|
  | `social.*`, `h2.*`, `title.*`, `meta-description.*` | `on-page` |
  | `directives.bot-conflict` | `indexability` |
  | `redirect.meta-refresh` | `redirects` |
  | `hreflang.html-lang-mismatch` | `hreflang` |
  | `links.*` | `links` |
  | `security.form-insecure`, `images.*`, `html.*` | `technical` |
  | `pagination.multiple` | `url` |
  | `extraction.not-recorded` | `crawl` |

- Copy areas: add **`"Social"`** and **`"HTML"`** to `AREAS` in `test/rules/copy.test.ts` (Task 1). Every other title uses an existing area.
- Fixture site: plain HTTP on `127.0.0.1`. New fixtures are `exact: true`.
  - If a new rule trips an existing `exact` fixture or the hub, read the page first. If it is a real defect of that page, add the id to its `expectedIssues`. Never loosen a rule to keep a fixture quiet.
  - Fixture defaults change in Task 2 (see there) so the common case stays quiet for the right reason.
- `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne` (container `ariadne-pg`). Chromium is installed.
- Each changed analyzer file keeps its OpenSEO provenance header and gains a "Phase 26b" change paragraph: `page-analyzer.ts` and its upstream oracle test. No re-lift, no sha change (hard rule 8).
- Commits are conventional, one per task (more is fine), each ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The controller, not the implementer, updates the Serena memory `roadmap` after each task's commit; it lives in the main checkout.

## Deviations from the spec text (owner to see in review)

1. **Three rules judge old crawls too**: `title.same-as-h1`, `h2.missing` and `social.og-duplicate` read columns that predate the bump (`title`, `h1_text`, `h2_count`, `og_title`, `og_description`). They need no refusal, so they judge every crawl. The "not measured on a pre-bump crawl" contract covers the other 23.
2. **Page rules cannot refuse a crawl** (they see one row, no db). A v2 page rule is silent on a null column. The new crawl-level marker **`extraction.not-recorded`** (info, query, `marker`) fires whenever any page row is below version 2. It claims every CHECK a v2-dependent rule claims, so a pre-bump crawl reads "not measured", never "pass". That is the 26th rule. Query rules refuse a mixed crawl whole, per `extractionCoverage`'s contract.
3. **og/X image refs join `resources`, not `page_resources`.** The spec says they join "the resource refs". A browser does not load an `og:image`, so it must not count toward page weight, mixed content or `resources.broken`. It becomes a `resources` row (kind `image`, so the resource pass fetches status and bytes), with no `page_resources` row. Existing resource rules and metrics judge only URLs with at least one `page_resources` row (verified, and enforced where missing, in Task 2).
4. **`robots_meta` on a v2 row holds every `<meta name=robots>` content, joined with `", "`.** Google combines repeated robots metas. Today the second one is lost, so `isIndexable` misses a later `noindex`. The bot-specific metas go to `robots_metas` (all of them, by name). `isIndexable` and `saysNoindex` are unchanged and now see every `robots` value. `robots_outside_head` stays first-element.
5. **`links.uncrawlable` counts an `<a>` without `href` only when it has `onclick` or `role="link"`/`role="button"`.** A bookmark (`<a name="top">`, `<a id="x">`) is not a link. "#-only" means the trimmed href is exactly `#` or `#!`. `#section` is in-page navigation and is not counted.
6. **"Closes `<head>` early" needs evidence the head was meant to continue.** The candidate is the first non-head start tag, non-head child of a head `<noscript>`, or non-whitespace text met while still in the head. It counts only if the document later has an explicit `</head>`, an explicit `<body>` start tag, or a head-only element (`title`, `meta`, `link`, `base`, `style`). A valid document that simply omits `</head>` and starts its body content is not flagged. With that evidence present, it is a warning even if no head tag was lost, as the spec says. Text is recorded as tag `#text` with the text as its snippet.
7. **Two new copy areas, "Social" and "HTML".** The rubric's area list has neither.
8. **CHECK mappings for the "new" rows.**
   - Social → new CHECK-87.
   - `html.structure-invalid` → new CHECK-88.
   - The three link-hygiene rows → existing CHECK-86.
   - `security.form-insecure` → existing CHECK-85, because insecure forms and mixed content are one check.
9. **`hreflang.html-lang-mismatch` compares the primary language subtag only** (`en-US` vs `en-gb` agree; `de` vs `en` do not). Region disagreement is common and legitimate. `x-default` is never compared.
10. **The 100-character alt threshold is applied at extraction.** The analyzer counts alts over `ALT_TEXT_LONG_CHARS` (100). `thresholds.ts` re-exports it as `IMAGE_ALT_MAX`, with a docblock saying a change needs an extraction bump.
11. **`social.image-broken`'s size limit is `SOCIAL_IMAGE_MAX_BYTES = 5 * 1024 * 1024`.**

## Review Focus

1. **A pre-bump crawl** (every page `extraction_version` 1) gets `extraction.not-recorded` with `{pagesNotRecorded, pagesRecorded: 0}`, and **no** finding from any v2-gated rule. A v2 crawl gets no marker. (Task 5 test; re-proved in Task 12 on the stored lavishalice crawl.)
2. **An og-only image URL that 404s** fires `social.image-broken` and fires nothing from `resources.broken`, `resources.bad-content-type`, `security.mixed-content` or the page-weight metrics. Its URL has no `page_resources` row. (Task 2 and Task 6 tests.)
3. **Head-closed-early boundaries** (Task 4 analyzer test and Task 11 rule test):

   | Input | Expected `closedEarly` |
   |---|---|
   | `<!doctype html><title>x</title><div>a</div>` | `null` |
   | `<head><meta charset=utf-8><noscript><iframe src="https://gtm/x"></iframe></noscript></head><body>` | `{tag:"iframe", inNoscript:true, snippet:'<iframe src="https://gtm/x">'}` |
   | `<head><div>x</div><title>t</title>` | `{tag:"div"}` |
   | `<head>hello</head>` | `{tag:"#text", snippet:"hello"}` |
   | a 500-character start tag | snippet capped at 200 |

4. **Anchors that are not links:**
   - `<a name="top"></a>` and `<a id="x">y</a>` are not counted.
   - `<a href="#section">` is not hash-only.
   - `<a href=" JavaScript:void(0)">` counts as `javascript`.
   - `<a href="">` counts as `emptyHref`, not `noHref`.
   - `<a target="_BLANK" rel="noopener" href="/x">` is not unsafe.

   (Task 3 test.)
5. **Language compare:**
   - `lang="en-US"` with a self hreflang `en-gb`: silent.
   - `lang="de"` with self `en`: fires.
   - `x-default` pointing to self is never compared.
   - A page with no `lang`: not this rule's finding.

   (Task 8 test.)

---

### Task 1: Schema, extraction bump, ruleset 0.21.0, checklist ids, fixture scaffold

**Files:**
- Create: `src/crawl/parse/page-facts.ts` (types, caps, `parseRefresh`)
- Modify: `src/db/schema.ts` (`pages` columns and indexes below); generate `drizzle/0026_*.sql` with `npm run db:generate`
- Modify: `src/crawl/versions.ts` (`EXTRACTION_VERSION = 2`, docblock line for what 2 adds); `src/crawl/response-headers.ts` (add `"refresh"`; 21 names)
- Modify: `src/rules/registry/registry.ts` (`RULESET_VERSION = "0.21.0"`, new note block); `src/rules/thresholds.ts` (new constants below)
- Modify: `skills/ariadne-audit/checklist.md`:
  - add CHECK-87 and CHECK-88
  - retitle CHECK-85 to "Mixed content and insecure forms"
- Modify: `test/rules/copy.test.ts` (`AREAS` gains `"Social"`, `"HTML"`)
- Modify: `test/rules/mk-page.ts`:
  - The clean page becomes a clean **v2** page: `extractionVersion: 2`, with clean values for every new column. That means a complete, consistent `social` set (`og` title/type/image/url, `x` card and title, counts 1, no conflicts), `titleCount: 1`, `metaDescriptionCount: 1`, `anchorCounts` all zero, `insecureRefs` all zero with an empty sample, zero image alt counts with an empty sample, `relNextCount: 0`, `relPrevCount: 0`, and `htmlStructure {htmlTags:1, headTags:1, bodyTags:1, headBeforeBody:true, closedEarly:null}`.
  - Every later rule must stay silent on it. The existing "clean page fires nothing" expectations must keep holding.
  - Add an exported `mkV1Page(overrides)` that sets every new column to null and `extractionVersion: 1`, for the v1-silence tests.
- Create: `test/fixtures/pages/authored-p26b.ts` exporting `authoredP26bFixtures: Fixture[] = []`, registered in `allFixtures()`
- Test: `test/db/migration-0026.test.ts` (new, modelled on `migration-0025.test.ts`), `test/crawl/page-facts.test.ts` (new); existing pins `test/crawl/persist.test.ts:449-450`, `test/fixtures/harness.test.ts:3689`, `test/crawl/response-headers.test.ts:48`, `test/rules/registry.test.ts:517`, `test/rules/thresholds.test.ts`

**Interfaces:**
- Produces, in `src/crawl/parse/page-facts.ts`:
  ```ts
  export type SocialTag = "og:title"|"og:description"|"og:image"|"og:url"|"og:type"|"og:site_name"
    |"twitter:card"|"twitter:title"|"twitter:description"|"twitter:image";
  export type SocialFacts = {
    og: Partial<Record<"title"|"description"|"image"|"url"|"type"|"site_name", string>>; // first value, raw, capped
    x: Partial<Record<"card"|"title"|"description"|"image", string>>;
    counts: Partial<Record<SocialTag, number>>;   // elements seen per tag
    conflicting: SocialTag[];                      // tags seen with ≥2 distinct trimmed values, sorted
    outsideHead: boolean;                          // any social tag met with the head closed
    xViaProperty: boolean;                         // a twitter:* tag given as property=
  };
  export type RobotsMetaEntry = { name: string; content: string }; // name lower-cased; bot-specific only (not "robots")
  export type RefreshFact = { raw: string; delaySeconds: number | null; target: string | null }; // target resolved absolute, or null
  export type AnchorCounts = { noHref: number; javascript: number; hashOnly: number; emptyHref: number; unsafeBlank: number };
  export type InsecureRefKind = "iframe" | "media" | "form";
  export type InsecureRefs = { iframe: number; media: number; formAction: number; forms: number;
    sample: { kind: InsecureRefKind; url: string }[] };
  export type HtmlStructure = { htmlTags: number; headTags: number; bodyTags: number;
    headBeforeBody: boolean | null;
    closedEarly: { tag: string; snippet: string; inNoscript: boolean } | null };
  export function parseRefresh(value: string, baseUrl: string): RefreshFact;
  ```
  - Caps:
    - `SOCIAL_TEXT_MAX = 300`
    - `SOCIAL_URL_MAX = 1024` (applies to `og.url`, `og.image`, `x.image`)
    - `ROBOTS_METAS_MAX = 10`
    - `ROBOTS_META_CONTENT_MAX = 512`
    - `REFRESH_RAW_MAX = 512`
    - `INSECURE_SAMPLE_MAX = 10`
    - `IMAGE_SAMPLE_MAX = 10`
    - `IMAGE_SAMPLE_SRC_MAX = 512`
    - `HEAD_SNIPPET_MAX = 200`
    - `HTML_LANG_MAX = 64`
    - `H2_TEXT_MAX = 300`
    - `ALT_TEXT_LONG_CHARS = 100`
    - `ROBOTS_META_BOTS = ["googlebot","googlebot-news","googlebot-image","googlebot-video","bingbot","msnbot","slurp","yandex","baiduspider","duckduckbot","applebot"] as const`
  - `parseRefresh` follows the HTML refresh algorithm:
    - leading digits (with an optional fraction) are the delay; non-numeric gives `delaySeconds: null`
    - then optional `;`/`,` and whitespace, an optional `url=` (any case) with optional quotes
    - the rest, trimmed, is the URL, resolved with `new URL(rest, baseUrl)`; `target: null` when absent or unresolvable
    - `raw` is capped at `REFRESH_RAW_MAX`
- Produces, `pages` columns (all nullable, no default; null means "not measured"):

  | Column | Type |
  |---|---|
  | `html_lang` | text |
  | `social` | jsonb `SocialFacts` |
  | `h2_text` | text |
  | `title_count` | smallint |
  | `meta_description_count` | smallint |
  | `robots_metas` | jsonb `RobotsMetaEntry[]` |
  | `meta_refresh` | jsonb `RefreshFact` |
  | `anchor_counts` | jsonb `AnchorCounts` |
  | `insecure_refs` | jsonb `InsecureRefs` |
  | `images_empty_alt` | integer |
  | `images_alt_too_long` | integer |
  | `images_missing_alt_sample` | jsonb `string[]` |
  | `rel_next_count` | smallint |
  | `rel_prev_count` | smallint |
  | `html_structure` | jsonb `HtmlStructure` |

  - drizzle names are the camelCase forms (`htmlLang`, `social`, `h2Text`, …).
- Produces, indexes, modelled exactly on `pages_dupe_title` (schema.ts:962):
  - `pages_dupe_h2_text` on `(crawl_id, btrim(h2_text), url)`
  - `pages_dupe_og_title` on `(crawl_id, btrim(og_title), url)`
  - `pages_dupe_og_description` on `(crawl_id, btrim(og_description), url)`
- Produces, `thresholds.ts`:
  - `H2_MAX = 70`
  - `IMAGE_ALT_MAX` (re-export of `ALT_TEXT_LONG_CHARS`, 100)
  - `SOCIAL_IMAGE_MAX_BYTES = 5 * 1024 * 1024`
  - `OG_REQUIRED = ["title","type","image","url"] as const`

- [ ] **Step 1: Write the failing tests.**
  - `migration-0026.test.ts`: every column above exists with its type and is nullable with no default; an insert omitting them reads null; the three indexes exist.
  - `page-facts.test.ts` › `parseRefresh`:

    | Input | Result |
    |---|---|
    | `"0; url=/next"` | `{delaySeconds:0, target:"<base origin>/next"}` |
    | `"5"` | `{delaySeconds:5, target:null}` |
    | `"3;URL='https://x.test/a'"` | `target:"https://x.test/a"` |
    | `"abc"` | `{delaySeconds:null, target:null}` |
    | `"0;url=http://[bad"` | `target:null` |
    | a 2,000-character value | `raw.length === 512` |

  - Flip the pins:
    - `EXTRACTION_VERSION` to 2 (persist and harness)
    - `RESPONSE_HEADER_ALLOWLIST` length to 21 and `includes("refresh")`
    - `RULESET_VERSION` to `"0.21.0"`
    - `thresholds.test.ts` to include the four new keys
- [ ] **Step 2:** Run `npx vitest run test/db/migration-0026.test.ts test/crawl/page-facts.test.ts test/crawl/response-headers.test.ts test/rules/registry.test.ts test/rules/thresholds.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Write the module, schema and generated migration.
  - Bump the versions; the note's first item lists the migration and the fact families.
  - Add the checklist entries (`Priority`, `Requires: Engine`, `Engine`, `Evaluate`; rule ids are named by the task that registers them), the areas, the mk-page defaults, and the fixture module.
  - `persist.ts` writes the new columns as `null` for now. The analyzer tasks fill them.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit`. Expect PASS, 0 skipped.
- [ ] **Step 5:** Commit `feat(db): phase 26b page facts schema (0026); extraction 2; ruleset 0.21.0`.

### Task 2: Analyzer — head facts and social set

**Files:**
- Modify: `src/crawl/parse/page-analyzer.ts`:
  - `PageAnalysis` gains `htmlLang`, `social`, `h2Text`, `titleCount`, `metaDescriptionCount`, `robotsMetas`, `metaRefresh`, `socialImageRefs: string[]`
  - each is added in the type, `analyzeHtml`'s return and `analyzePage`'s mapping
  - append to the header change log
- Modify: `src/crawl/persist.ts` (`pageRow` maps the fields; `socialImageRefs` become `resources` rows `{crawlId, url, kind:"image"}` through the existing buffer, never `page_resources`)
- Modify: resource rules and metrics (`src/rules/query/resources.ts`, `src/rules/metric/resource-metrics.ts`, `src/rules/query/security.ts`):
  - verify each judges only URLs with a `page_resources` row
  - add the condition where it does not, with a comment citing deviation 3
- Modify: `src/crawl/parse/page-analyzer.upstream.test.ts` (oracle or `EXTENSION_FIELDS`, and its header), `test/fixtures/render.ts`:
  - `PageSpec.htmlLang?: string` (default `"en"`)
  - `PageSpec.social?: false | Partial<SocialFacts["og"] & {xCard:string}>`
  - by default `renderDocument` emits a complete, consistent set: `og:title` = title, `og:type` `website`, `og:url` = the page's own URL, `og:image` = the fixture site's existing shared image asset (resolve its path from `test/fixtures/assets.ts`), `twitter:card` `summary_large_image`, `twitter:title` = title
- Test: `test/crawl/analyzer-extensions.test.ts`, `test/crawl/persist.test.ts`, `test/rules/resources-query.test.ts`

**Interfaces:**
- Consumes: Task 1 types and caps.
- Produces, analyzer semantics:
  - `htmlLang`: the first `<html>` start tag's `lang`, trimmed, capped at `HTML_LANG_MAX`; null when absent or empty.
  - `social`: built in `handleMetaTag`.
    - og tags are read from `property=` **or** `name=`.
    - `twitter:*` is read from `name=`, or from `property=`, which sets `xViaProperty`.
    - Each first value is trimmed and capped (text 300, url 1024).
    - `counts` counts every element.
    - `conflicting` lists the tags seen with two or more distinct trimmed values.
    - `outsideHead` is true if any social tag arrives with `headMode === "body"`.
    - `social` is `null` only when the page has no social tag at all. (Rules treat a null `social` on a v2 row as "no tags"; the row's `extractionVersion` distinguishes it from v1.)
  - The existing `ogTitle`/`ogDescription`/`ogImage` stay exactly as today (first `property=` value, raw) for their consumers.
  - `socialImageRefs`: `og:image` and `twitter:image` values resolved with `normalizeUrl(value, pageUrl)`, deduped, at most 4; unresolvable values are skipped (the raw value stays in `social`).
  - `h2Text`: the first `<h2>`'s text, whitespace-collapsed, capped at `H2_TEXT_MAX`, collected exactly like `h1Text`.
  - `titleCount`: `<title>` elements outside `<svg>`. `metaDescriptionCount`: `<meta name=description>` elements. Both are counts and never null on a v2 page.
  - `robotsMetas`: metas whose lower-cased `name` is in `ROBOTS_META_BOTS`, in document order, at most 10, content capped at 512.
  - `robotsMeta` (deviation 4): every `name=robots` content, joined with `", "`. It is null when there is none.
  - `metaRefresh`: the first `<meta http-equiv=refresh content>` through `parseRefresh(content, pageUrl)`; null when there is none.
  - Metas inside `<noscript>` stay ignored, as today.

- [ ] **Step 1: Write failing tests** in `analyzer-extensions.test.ts`, one `describe` per fact.

  | Fact | Input | Expected |
  |---|---|---|
  | lang | `<html lang=" en-GB ">` | `"en-GB"` |
  | lang | no lang | `null` |
  | social: duplicate tag | `og:title` twice with different values | `counts["og:title"]===2`, `conflicting` contains it |
  | social: twitter via property | `<meta property="twitter:card">` | `xViaProperty` |
  | social: og via name | `<meta name="og:title">` | captured |
  | social: body tag | an og tag in `<body>` after a `<div>` | `outsideHead` |
  | social: relative image | relative `og:image` | `socialImageRefs` holds the resolved URL; `social.og.image` holds the raw value |
  | social: no tags | — | `null` |
  | h2Text | `<h2> A <b>b</b> </h2>` | `"A b"` |
  | counts | two titles, two descriptions | 2 and 2 |
  | robots | `robots` `index` + `robots` `noarchive` + `googlebot` `noindex` | `robotsMeta === "index, noarchive"`, `robotsMetas === [{name:"googlebot",content:"noindex"}]` |
  | refresh | `<meta http-equiv="Refresh" content="0;url=/x">` | target resolved |

  - In `persist.test.ts`: an analysed page with an `og:image` writes a `resources` row and no `page_resources` row for it.
  - In `resources-query.test.ts`: an og-only resource with `status_code` 404 fires no `resources.broken` (Review Focus 2).
- [ ] **Step 2:** Run `npx vitest run test/crawl/analyzer-extensions.test.ts test/crawl/persist.test.ts test/rules/resources-query.test.ts src/crawl/parse/page-analyzer.upstream.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `htmlLang` is read in the existing `case "html"`. `addResource` must not be used for social images, because it feeds `resourceRefs`, which becomes `page_resources`. Keep `socialImageRefs` separate.
  - Reconcile the fixture harness after the `renderDocument` defaults change:
    - Run `npx vitest run test/fixtures/harness.test.ts`.
    - Read each newly differing fixture. A real defect gets added to `expectedIssues`. A fixture whose page should not carry the defaults (for example an absorbed badseo page) is left as it is.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit`. Expect PASS, 0 skipped. Coverage is unchanged (154).
- [ ] **Step 5:** Commit `feat(parse): html lang, social set, h2 text, head counts, robots metas, meta refresh (26b)`.

### Task 3: Analyzer — links, pagination counts, insecure references, images

**Files:**
- Modify: `src/crawl/parse/page-analyzer.ts`, `src/crawl/persist.ts`, the upstream oracle test
- Test: `test/crawl/analyzer-extensions.test.ts`, `test/crawl/persist.test.ts`

**Interfaces:**
- Produces, analyzer fields:
  - `anchorCounts: AnchorCounts`, counted over every `<a>` start tag outside `<noscript>`:
    - `noHref`: no `href` attribute **and** (`onclick` present, or `role` is `link`/`button` case-insensitive) — deviation 5
    - `emptyHref`: `href` present and `""` after trim
    - `javascript`: `/^\s*javascript:/i`
    - `hashOnly`: trimmed href is `#` or `#!`
    - `unsafeBlank`: `target` equals `_blank` (case-insensitive), href present and not `javascript:`, and the `rel` tokens contain neither `noopener` nor `noreferrer`
  - Anchor text: an `<img>` inside an open anchor pushes its trimmed `alt` (when present and non-empty) into `openAnchor.text`, as a text node would. `links.anchor` therefore includes image alt on v2 rows. The cheerio oracle must do the same, computing the text with `img[alt]` alt folded in, so parity holds.
  - `relNextCount`, `relPrevCount`: every `<link rel~=next|prev>` (with or without href); the first-only `relNext`/`relPrev` are unchanged.
  - `insecureRefs: InsecureRefs`. A reference counts when its value resolves (`normalizeUrl`) to an `http:` URL. Kinds:
    - `iframe`: `<iframe src>`
    - `media`: `<video src|poster>`, `<audio src>`, `<source src>` inside `<video>`/`<audio>`, `<track src>`, `<embed src>`, `<object data>`
    - `form`: `<form action>` (`formAction`)
    - `forms` counts every `<form>` start tag
    - `sample`: the first 10 `{kind, url}`, in document order
    - recorded for every page; the rules decide by the page's scheme
  - `imagesEmptyAlt`: `alt` present and `""` after trim. `imagesAltTooLong`: alt length after trim > `ALT_TEXT_LONG_CHARS`. `imagesMissingAltSample`: the raw `src` of the first 10 images with no `alt` attribute, each capped at 512. All are counted in the existing `case "img"`.

- [ ] **Step 1: Write failing tests.**
  - Review Focus 4, exactly.
  - Anchor text:
    - `<a href="/x"><img src="a.png" alt="Logo"></a>` gives anchor `"Logo"`.
    - `<a href="/x"><img src="a.png"></a>` gives anchor `""`.
  - `<link rel="next" href="/2"><link rel="next" href="/3">`: `relNextCount === 2`, `relNext === "/2"`.
  - On a page analysed as `https://s.test/`, `<iframe src="http://x.test/a">` + `<video><source src="http://x.test/v.mp4"></video>` + `<form action="http://x.test/post">` + `<form action="/ok">` gives `{iframe:1, media:1, formAction:1, forms:2}` and a 3-item sample.
  - 12 images without alt give a sample of 10 in document order.
  - `alt=""` counts empty.
  - A 101-character alt counts too long; a 100-character alt does not.
- [ ] **Step 2:** Run the Task 2 analyzer and parity commands. Expect FAIL.
- [ ] **Step 3:** Implement, map in `persist.ts`, and add the provenance change-log line.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit`. Expect PASS. Reconcile any harness fixture whose `links` anchors changed, following the Task 2 rule.
- [ ] **Step 5:** Commit `feat(parse): anchor counts and image alt in anchors, rel counts, insecure refs, alt facts (26b)`.

### Task 4: Analyzer — HTML structure

**Files:**
- Modify: `src/crawl/parse/page-analyzer.ts`, `src/crawl/persist.ts`, the upstream oracle test (structure facts go in `EXTENSION_FIELDS`, with their own cheerio-free tests)
- Test: `test/crawl/page-analyzer.test.ts` (the head-mode suite)

**Interfaces:**
- Produces: `htmlStructure: HtmlStructure`.
  - `htmlTags`, `headTags`, `bodyTags` are counts of **explicit** start tags. htmlparser2 implies none of them; `isImplied` tags are not counted.
  - `headBeforeBody` is true when the first explicit `<head>` precedes the first explicit `<body>`, false when it follows, and null when either is absent.
  - `closedEarly` follows deviation 6.
    - Pass `attribs` and the parser's `startIndex`/`endIndex` into `headOnOpenTag`.
    - While in head mode, the first candidate is one of:
      - a start tag outside `HEAD_ALLOWED`;
      - a start tag inside a head `<noscript>` that is not `link`, `meta` or `style` (`inNoscript: true`);
      - non-whitespace text (`#text`, snippet = the trimmed text).
    - The candidate is recorded with `snippet = html.slice(startIndex, endIndex + 1)` capped at `HEAD_SNIPPET_MAX`.
    - It is confirmed at end of parse only if an explicit `</head>`, an explicit `<body>` start tag, or a `title`/`meta`/`link`/`base`/`style` start tag came after it. Otherwise `closedEarly` is null.
  - The existing `headClosedBy`, `headMode` transitions and every `*OutsideHead` flag are unchanged.
  - The head-noscript detection must not change those flags: today a head noscript's children are invisible to the head machine, and they stay so for the existing facts.

- [ ] **Step 1: Write failing tests:** the Review Focus 3 table, plus these:

  | Input | Expected |
  |---|---|
  | `<html><head></head><body></body><body></body>` | `bodyTags:2` |
  | `<body></body><head></head>` | `headBeforeBody:false` |
  | no explicit tags at all | counts 0, `headBeforeBody: null` |

  - A 20 MB-safe check: a document with 100,000 `<div>`s produces a `closedEarly` snippet of at most 200 characters and no array growth. State is scalar.
- [ ] **Step 2:** Run `npx vitest run test/crawl/page-analyzer.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement and map.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `feat(parse): html structure facts — explicit tag counts, order, early head close (26b)`.

### Task 5: The v2 gate and `extraction.not-recorded`

**Files:**
- Create: `src/rules/query/page-facts.ts`, exporting:
  - `pageFactsRules: QueryRule[]`
  - `v2Gate(db, crawlId): Promise<{ recorded: boolean; atOrAbove: number; below: number }>`, a thin wrapper over `extractionCoverage(db, crawlId, 2)`
- Modify: `src/rules/index.ts`, `issue-copy.ts`, checklist (each claimed CHECK's entry names the marker; CHECK-83's family list gains it), `test/fixtures/harness.test.ts` (`SKIP_HARNESS_CLAIMS` + paragraph: the fixture crawl is always current, so the marker cannot fire there)
- Test: `test/rules/page-facts-query.test.ts` (new)

**Interfaces:**
- `extraction.not-recorded`:
  - info / `crawl`, `marker`
  - `checkIds`: `CHECK-04, CHECK-10, CHECK-18, CHECK-22, CHECK-24, CHECK-25, CHECK-34, CHECK-35, CHECK-36, CHECK-37, CHECK-49, CHECK-85, CHECK-86, CHECK-87, CHECK-88`
  - fires once (`dedupeKey "site"`, `pageId null`) when `below > 0` and the crawl has at least one `FETCHED_OK` page
  - evidence `pagesNotRecorded`, `pagesRecorded`
  - marker sentence: "This crawl was extracted before the page facts these checks read existed, so they were not run; re-crawl the site."
- Every later v2 query rule calls `v2Gate` first and returns `[]` when `!recorded`.

- [ ] **Step 1: Write failing tests:**
  - Review Focus 1 (seed pages with `extractionVersion: 1`)
  - a mixed crawl (one v1 and one v2 page) fires with `{1, 1}`
  - an all-v2 crawl is silent
  - an empty crawl is silent
  - a missing crawl throws
- [ ] **Step 2:** Run `npx vitest run test/rules/page-facts-query.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement, register, copy, checklist, skip entry. Counts: **155 = 49 page + 92 query + 14 metric; 33 / 54 / 68**.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `feat(rules): extraction.not-recorded marker and the v2 gate (26b)`.

### Task 6: Social rules (4 page + 2 query) and social tags outside the head

**Files:**
- Create: `src/rules/page/social.ts` (`socialRules: PageRule[]`), `src/rules/query/social.ts` (`socialQueryRules: QueryRule[]`)
- Modify: `src/rules/query/field-duplicates.ts`: export `groupFindings`, or reuse it in place; do not copy it
- Modify: `src/rules/page/head.ts` (`tagsOutside` adds `"social"` when `p.social?.outsideHead === true`), `src/rules/index.ts`, `issue-copy.ts`, checklist CHECK-87 and CHECK-35
- Modify: `src/rules/query/resources.ts` (`resources.not-recorded` and `resources.not-fetched` gain `CHECK-87`, because the image's status and size need the resource pass)
- Test: `test/rules/social.test.ts`, `test/rules/social-query.test.ts`, `test/rules/head.test.ts`

**Interfaces:**

| Rule | Kind / severity | Fires on (gate `isJudged`) | Evidence (columns) |
|---|---|---|---|
| `social.og-incomplete` | page / info | v2 row (`extractionVersion >= 2`) whose `social` is null or lacks any of `OG_REQUIRED` | `missing` (string[], in `OG_REQUIRED` order) "Missing OG Tags"; `none` (bool) "No OG Tags" |
| `social.og-multiple` | page / info | `social.conflicting` has an `og:` tag | `tags` "Conflicting Tags" |
| `social.og-url-mismatch` | page / info | `social.og.url` present and its `normalizeUrl(…, page.url)` differs from `resolveEffectiveCanonical(page)?.resolved ?? normalizeUrl(page.url)` | `ogUrl` "OG URL", `canonical` "Canonical" |
| `social.x-incomplete` | page / info | v2 row with: `xViaProperty`; or no `twitter:card`; or a card with no title (`x.title` ?? `og.title`) | `missing` (string[]) "Missing X Tags"; `viaProperty` (bool) "Given as property=" |
| `social.og-duplicate` | query / info | `groupFindings` over `og_title`, then over `og_description`, concatenated. `dedupeKey` prefixed with the field. No v2 gate (deviation 1) | `groupFindings`' keys plus `field` ("og:title" / "og:description") |
| `social.image-broken` | query / warning | v2 crawl (`v2Gate`). Per judged page, each of `social.og.image` / `social.x.image` that is relative (no `http:`/`https:` scheme) or fails `new URL`; or, resolved, matches a `resources` row with `status_code` not null and ≠ 200, or `bytes > SOCIAL_IMAGE_MAX_BYTES`. One finding per page | `images` [{tag, url, problem: "relative"\|"invalid"\|"status"\|"too-large", statusCode?, bytes?}] "Image Problems" |

- `social.og-incomplete` and `social.x-incomplete` fire only on v2 rows. That a v2 row with a null `social` means "no tags" is safe only because `extractionVersion` says the analyzer ran.
- `social.image-broken` with the resource pass not run (`status_code` null) judges only the relative/invalid half. The resource markers speak for the rest.

- [ ] **Step 1: Write failing tests:**
  - each rule positive and negative
  - a v1 row (`extractionVersion: 1`, `social: null`) is silent for the four page rules
  - Review Focus 2's `social.image-broken` half
  - an og image at 6 MB fires `too-large`
  - an `og:url` equal to the page URL with a trailing-slash variant is silent only when `normalizeUrl` equates them; pin both ways
  - `head.tags-outside-head` names `social`
- [ ] **Step 2:** Run `npx vitest run test/rules/social.test.ts test/rules/social-query.test.ts test/rules/head.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement, register, copy, checklist. Add fixtures:
  - `/p26b/og-incomplete` (`social: {image: undefined}` → the default set minus image)
  - `/p26b/og-multiple`
  - `/p26b/og-url-mismatch`
  - `/p26b/x-incomplete` (`twitter:card` given as `property=`)
  - two pages sharing one `og:title` with different titles
  - `/p26b/og-image-relative`
- [ ] **Step 4:** Counts: **161 = 53 page + 94 query + 14 metric; 33 / 55 / 73**. Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `feat(rules): open graph and X card rules (26b)`.

### Task 7: H2, title and description rules (5 page + 1 query)

**Files:**
- Modify: `src/rules/page/on-page.ts`, `src/rules/query/field-duplicates.ts` (`h2.duplicate` through `groupFindings` on `h2_text`, gated by `v2Gate`), `src/rules/index.ts`, `issue-copy.ts`, checklist CHECK-35, CHECK-36, CHECK-37
- Test: `test/rules/on-page.test.ts`, `test/rules/field-duplicates.test.ts`

**Interfaces** (gate `isJudged`):

| Rule | Severity / checks | Fires on | Evidence (columns) |
|---|---|---|---|
| `h2.missing` | info / CHECK-37 | `h2Count === 0` (all crawls, deviation 1) | `h2Count` "H2 Count" |
| `h2.too-long` | info / CHECK-37 | `h2Text` non-null and `length > H2_MAX` | `h2Text`, `length`, `max` (as `headings.h1-too-long`) |
| `h2.duplicate` | info / CHECK-37 | first H2 shared across judged pages (`groupFindings`) | its keys |
| `title.multiple` | warning / CHECK-35 | `titleCount > 1` | `titleCount` "Title Elements" |
| `meta-description.multiple` | warning / CHECK-36 | `metaDescriptionCount > 1` | `metaDescriptionCount` "Meta Description Elements" |
| `title.same-as-h1` | info / CHECK-35 | `title` and `h1Text` both non-empty and equal after whitespace collapse and trim, case-insensitive (all crawls) | `title`, `h1Text` |

- [ ] **Step 1: Write failing tests:**
  - positives and negatives for each rule
  - the v1-null silence for `h2.too-long`, `title.multiple` and `meta-description.multiple`
  - `h2.duplicate` refuses a v1 crawl
  - `"Shoes "` vs `"shoes"` fires `title.same-as-h1`
- [ ] **Step 2:** Run those test files. Expect FAIL.
- [ ] **Step 3:** Implement and add fixtures for each. `h2.missing` is likely already produced by existing pages: check the harness diff and reconcile.
- [ ] **Step 4:** Counts: **167 = 58 page + 95 query + 14 metric; 33 / 57 / 77**. Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `feat(rules): h2, multiple title/description, title equals h1 (26b)`.

### Task 8: Bot directives, meta refresh, html lang (2 page + 1 query)

**Files:**
- Modify: `src/rules/page/directives.ts`, `src/rules/page/redirects.ts`; if that file does not exist, create `src/rules/page/refresh.ts`, `refreshRules`
- Modify: `src/rules/query/hreflang-integrity.ts` (or a new `hreflang-lang.ts`; reuse the file's `DECLARATIONS` CTE), `src/rules/index.ts`, `issue-copy.ts`, checklist CHECK-04, CHECK-10, CHECK-25
- Test: `test/rules/directives.test.ts`, `test/rules/refresh.test.ts`, `test/rules/hreflang-integrity-query.test.ts`

**Interfaces:**

| Rule | Severity / checks | Fires on (gate `isAuditable`) | Evidence (columns) |
|---|---|---|---|
| `directives.bot-conflict` | warning / CHECK-04 | for a `robotsMetas` entry, its `noindex` or `nofollow` state (via `robotsTokens`; `none` counts as both) differs from the combined `robotsMeta` state, where an absent `robotsMeta` means index, follow. One finding per page | `conflicts` [{bot, differs: ("noindex"\|"nofollow")[], botDirectives, robotsDirectives}] "Bot Conflicts" |
| `redirect.meta-refresh` | warning / CHECK-10 | `metaRefresh.target` non-null; or the stored `refresh` response header (`responseHeaders.values.refresh[0]`) parsed by `parseRefresh(value, page.url)` has a target | `source` ("meta"/"header"/"both"), `target`, `delaySeconds` (optional), `selfTarget` (bool: `normalizeUrl(target) === normalizeUrl(page.url)`) |
| `hreflang.html-lang-mismatch` | info / CHECK-25 | `v2Gate`. Page's `html_lang` non-null; its self-referencing html-source hreflang codes (excluding `x-default`); their primary subtags (before `-`, lower-cased) do not include `html_lang`'s primary subtag. SQL; capped | `htmlLang` "HTML Lang", `hreflangCodes` "Self Hreflang" |

- [ ] **Step 1: Write failing tests:**
  - Review Focus 5
  - `robots` `index` + `googlebot` `noindex` fires `differs:["noindex"]`
  - no `robots` + `bingbot` `nofollow` fires
  - `googlebot` `noindex` + `robots` `noindex, nofollow` gives `differs:["nofollow"]`
  - refresh with no URL is silent
  - header-only refresh fires `source:"header"`
  - a v1 row (null `metaRefresh`, no refresh header) is silent
- [ ] **Step 2:** Run those test files. Expect FAIL.
- [ ] **Step 3:** Implement and add fixtures:
  - `/p26b/bot-conflict`
  - `/p26b/meta-refresh`
  - an hreflang pair whose `fr` page keeps `lang="en"` (set `htmlLang` on the factory; reconcile existing hreflang fixtures so their `htmlLang` matches their code)
- [ ] **Step 4:** Counts: **170 = 60 page + 96 query + 14 metric; 33 / 59 / 78**. Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `feat(rules): bot directive conflicts, meta refresh, html lang vs hreflang (26b)`.

### Task 9: Link rules (3 page + 1 query)

**Files:**
- Create: `src/rules/page/anchors.ts` (`anchorRules: PageRule[]`)
- Modify: `src/rules/query/link-hygiene.ts` (`links.no-anchor-text`), `src/rules/index.ts`, `issue-copy.ts`, checklist CHECK-34, CHECK-86
- Test: `test/rules/anchors.test.ts`, `test/rules/link-hygiene-query.test.ts`

**Interfaces** (gate `isAuditable`):

| Rule | Severity / checks | Fires on | Evidence (columns) |
|---|---|---|---|
| `links.uncrawlable` | warning / CHECK-34 | `anchorCounts` non-null and `noHref + javascript + hashOnly > 0` | `noHref`, `javascript`, `hashOnly` (labelled "No href", "javascript: href", "# href") |
| `links.empty-href` | info / CHECK-86 | `anchorCounts.emptyHref > 0` | `emptyHref` "Empty href" |
| `links.unsafe-target-blank` | info / CHECK-86 | `anchorCounts.unsafeBlank > 0` | `unsafeBlank` "target=_blank without noopener" |
| `links.no-anchor-text` | info / CHECK-86 | `v2Gate`. Per `FETCHED_OK` source page, internal `links` rows whose `btrim(anchor) = ''`. One finding per page. SQL, capped | `count` "Links Without Anchor Text", `targets` (≤ `SAMPLE_SOURCES`, sorted) "Targets" |

- `links.no-anchor-text` reads the stored anchor, which on v2 rows includes image alt (Task 3). Only the first anchor per target is stored, so a target reached first by an empty image link and later by a text link reads empty. Say so in the copy-free docblock; it is the existing link-dedupe contract.

- [ ] **Step 1: Write failing tests:**
  - positives and negatives
  - v1-null silence
  - an image link with alt is not "no anchor text"
  - an image link without alt is
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement and add fixtures:
  - `/p26b/uncrawlable-links` (onclick no-href, `javascript:`, `#`)
  - `/p26b/empty-href`
  - `/p26b/target-blank`
  - `/p26b/image-link-no-alt`
- [ ] **Step 4:** Counts: **174 = 63 page + 97 query + 14 metric; 33 / 60 / 81**. Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `feat(rules): uncrawlable, empty, unsafe target=_blank and textless links (26b)`.

### Task 10: Forms, image alt, pagination count; mixed content widens; missing-alt sample (4 page + 2 revisions)

**Files:**
- Modify: `src/rules/page/technical.ts` (`images.empty-alt`, `images.alt-too-long`; `images.missing-alt` gains optional `sample` "Images Missing Alt (sample)" when `imagesMissingAltSample` is non-null)
- Modify: `src/rules/page/security.ts`; if it does not exist, put `security.form-insecure` in `src/rules/page/technical.ts`
- Modify: `src/rules/page/url-shape.ts` or the 26a pagination page-rule home (`pagination.multiple`)
- Modify: `src/rules/query/security.ts` (`security.mixed-content` widens)
- Modify: `src/rules/index.ts`, `issue-copy.ts`, checklist CHECK-49, CHECK-85, CHECK-22
- Test: `test/rules/technical.test.ts`, `test/rules/security-query.test.ts`, `test/rules/pagination-*.test.ts`

**Interfaces:**

| Rule | Severity / checks | Fires on | Evidence (columns) |
|---|---|---|---|
| `security.form-insecure` | warning / CHECK-85 | `isAuditable`, `insecureRefs` non-null, and either an `https:` page with `formAction > 0`, or an `http:` page with `forms > 0` | `pageScheme`, `formAction` (optional), `forms`, `sample` (form entries only, optional) |
| `images.empty-alt` | info / CHECK-49 | `isJudged`, `imagesEmptyAlt > 0` | `imagesEmptyAlt`, `imagesTotal` |
| `images.alt-too-long` | info / CHECK-49 | `isJudged`, `imagesAltTooLong > 0` | `imagesAltTooLong`, `max` (`IMAGE_ALT_MAX`) |
| `pagination.multiple` | info / CHECK-22 | `isAuditable`, `relNextCount > 1 \|\| relPrevCount > 1` | `relNextCount`, `relPrevCount` |

- `security.mixed-content`, in one SQL statement:
  - the existing `page_resources` part
  - **plus**, for v2 HTTPS pages, `insecure_refs.iframe + insecure_refs.media`, with their sample entries of kind `iframe`/`media`
  - `insecureCount` is the sum; `sample` merges both, sorted, capped at `BROKEN_SAMPLE_RESOURCES`
  - new optional evidence `byKind` {resources, iframe, media}
  - v1 pages behave exactly as before; pin it

- [ ] **Step 1: Write failing tests:**
  - positives and negatives
  - v1-null silence for the four page rules
  - mixed content on an https v2 page with only an `http:` iframe fires `byKind.iframe: 1`
  - a v1 https page's result is byte-identical to the 0.20.0 result
  - `images.missing-alt` on a v1 row has no `sample` key
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement and add fixtures:
  - `/p26b/empty-alt`
  - `/p26b/long-alt`
  - `/p26b/pagination-multiple`
  - `/p26b/http-form` (the fixture site is HTTP, so a page with a form fires; check every existing fixture with a `<form>` and reconcile)
  - Mixed-content widening stays in `SKIP_HARNESS_CLAIMS` (HTTPS only).
- [ ] **Step 4:** Counts: **178 = 67 page + 97 query + 14 metric; 33 / 61 / 84**. Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `feat(rules): insecure forms, alt facts, multiple pagination links; mixed content widens (26b)`.

### Task 11: HTML structure rules (2 page) and the head rules name their cause

**Files:**
- Create: `src/rules/page/html-structure.ts` (`htmlStructureRules: PageRule[]`)
- Modify: `src/rules/page/head.ts`: `head.directives-outside-head` and `head.tags-outside-head` gain optional evidence `headClosedEarly` {tag, snippet} "Head Closed By (element)" when `htmlStructure?.closedEarly` is non-null
- Modify: `src/rules/index.ts`, `issue-copy.ts`, checklist CHECK-18, CHECK-04, CHECK-24, CHECK-88
- Test: `test/rules/html-structure.test.ts`, `test/rules/head.test.ts`

**Interfaces** (gate `isAuditable`):

| Rule | Severity / checks | Fires on | Evidence (columns) |
|---|---|---|---|
| `html.head-closed-early` | warning / CHECK-18, CHECK-04, CHECK-24 | `htmlStructure?.closedEarly` non-null | `tag` "Closing Element", `snippet` "Element Snippet", `inNoscript` "Inside noscript" |
| `html.structure-invalid` | info / CHECK-88 | `htmlStructure` non-null, and `headTags !== 1` or `bodyTags !== 1` or `headBeforeBody === false` | `problems` (string[] from "head-missing", "head-repeated", "body-missing", "body-repeated", "head-after-body") "Problems", `headTags`, `bodyTags` |

- [ ] **Step 1: Write failing tests:**
  - Review Focus 3 at rule level
  - the problem vocabulary, one case each
  - v1-null silence
  - the head rules carry `headClosedEarly` on a v2 row and omit it on a v1 row
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. Add fixtures with a raw handler (`res.end(html)`; `renderDocument` cannot emit a malformed document):
  - `/p26b/head-closed-noscript-iframe` (the GTM shape)
  - `/p26b/head-closed-div`
  - `/p26b/no-head-tag`
  - `/p26b/two-bodies`
  - The existing outside-head fixtures will now also fire `html.head-closed-early`. Reconcile them: it is a real defect of those pages.
- [ ] **Step 4:** Counts: **180 = 69 page + 97 query + 14 metric; 33 / 62 / 85**. Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `feat(rules): early head close and invalid document structure (26b)`.

### Task 12: Surfaces and the 26b gate

**Files:**
- Modify: `docs/talos-surface.md`:
  - header to ruleset 0.21.0 / migrations 0000–0026
  - a "What Phase 26b changed here" block naming all 26 ids by family with `(severity)` and CHECK
  - counts: 180 rows, 69/97/14, 15 markers, 33/62/85; the catalog byte count re-measured
  - the RULESET_VERSION section
- Modify: `skills/ariadne-audit/SKILL.md`, `skills/ariadne-report/SKILL.md`: a 0.21.0 paragraph in each, in the 26a style. It says these rules need a re-crawl and that a pre-bump crawl answers `extraction.not-recorded`.
- Create: `docs/gates/phase-26b.md`
- Test: `test/skills/identifier-guard.test.ts` (existing; must stay green)

**Gate run** (scripts live in the git-ignored SDD workspace, as in Phase 25; only the gate doc is committed):
1. `npm test` green with 0 skipped; `npx tsc --noEmit` clean. Record the counts.
2. **Pre-bump refusal on real data:**
   - Run the 0.21.0 rules over the stored v1 lavishalice crawl `crawl_11e15602-63c4-4aa4-8b94-fb3b65908f19` (602 pages, no re-crawl).
   - Expect `extraction.not-recorded` with `pagesNotRecorded` equal to the crawl's page count, and zero findings from every v2-gated rule.
   - The three deviation-1 rules may fire. Review them for false positives.
3. **Re-crawl lavishalice** with the Phase 25 recipe:
   - `ApiService.startCrawl({siteUrl:"https://lavishalice.com/", maxPages:600, fetchResources:false})`, render pass on, other defaults
   - one Node process under `/usr/bin/time -v`, plus a 250 ms RSS sampler
   - this is a polite, permitted crawl: the branded UA, robots and the per-host governor, exactly as Phase 25
   - Record:
     - peak RSS (`Maximum resident set size`), which must be ≤ **246.3 MB** (Phase 25's 223.9 MB + 10%)
     - per-row growth: `select avg(coalesce(pg_column_size(html_lang),0) + … + coalesce(pg_column_size(html_structure),0))` over all 15 new columns, plus `max(…)`; the average must be ≤ **2,048 bytes**
4. **False-positive review:**
   - Run the rules on the new crawl.
   - For each of the 25 rules, record its count and hand-check up to 5 findings against the live page (GET only, one at a time, the crawler's UA, spaced ≥ 2.5 s, at most 40 requests).
   - Fix a real false positive in the rule with a regression test before writing the doc.
   - Also re-check `social.image-broken` with `fetchResources:false`: relative/invalid only.
5. `docs/gates/phase-26b.md`: clauses 1–4 with numbers, the per-rule table (count / checked / verdict), the deviations list as built, and anything parked.

- [ ] **Step 1:** Update the surfaces. Run `npx vitest run test/skills`. Expect PASS.
- [ ] **Step 2:** Run gate clauses 1–4. If clause 3 fails a budget, find the cause with a heap snapshot or row-size breakdown. Do not raise the budget (hard rule 6).
- [ ] **Step 3:** Write the gate doc.
- [ ] **Step 4:** Run `npm test && npx tsc --noEmit`. Expect PASS.
- [ ] **Step 5:** Commit `docs: phase-26b gate — 26 rules, extraction 2, lavishalice re-crawl`.

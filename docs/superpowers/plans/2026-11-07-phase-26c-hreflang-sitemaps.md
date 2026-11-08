# Phase 26c: Multi-source hreflang and sitemap limits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read hreflang from all three sources (HTML, the HTTP `Link` header, sitemap `xhtml:link`), keep every sitemap a URL is listed in, stream sitemaps up to the protocol's 50 MB, and land the four items Phase 26b parked for 26c. Ruleset 0.22.0, `EXTRACTION_VERSION` 3, one migration (0029), five new rules (187 in all). End with a gate: the 50k memory run, a streamed 50 MB sitemap probe, a Hurtigruten crawl with sitemap hreflang, and a false-positive review.

**Architecture:**
- **Sitemaps stream.** A new pure module, `src/crawl/sitemap-stream.ts`, feeds the response body (gunzipped as a stream) into htmlparser2 in `xmlMode`, chunk by chunk. It emits one entry per `<url>` with its `xhtml:link` alternates and never holds a document. `discover` still keeps its deduped entry `Map` for the frontier, unchanged in shape. Memberships (every URL × every sitemap that lists it) and sitemap alternates go to two new tables through a batched sink, never into that `Map`.
- **Sitemap hreflang reaches `hreflang` through a derivation.** Pages do not exist yet when a sitemap is read, so the alternates are staged in `sitemap_hreflang`. A new idempotent derivation in `src/rules/run.ts` (beside `deriveClickDepth`) rewrites `hreflang` rows with `source='sitemap'` from that staging table, joined to the crawl's pages on `url_normalised`, before the rules run.
- **Header hreflang is fetch-time extraction.** A new RFC 8288 `Link` parser (`src/crawl/link-header.ts`) reads the full response header at fetch. The stored copy is capped at 2,048 characters, so it can't be the source. Persist writes `source='header'` rows for every fetched page, HTML or not.
- **The parked parser items** (`og:image:secure_url`, a link's wider accessible name, over-long URL counts) are page facts. They and header hreflang make one extraction bump, to 3. Rules that need v3 facts refuse a pre-v3 crawl, and the existing marker `extraction.not-recorded` says so.

**Tech Stack:** TypeScript strict / ESM, Node 22, Postgres 16, drizzle-orm + drizzle-kit, htmlparser2 (hot path and the new sitemap stream), node:zlib streams, vitest, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-11-05-phase-26-checks-wave-1-design.md`, the 26c section and "Gate 26c" (owner-approved 2026-11-05). The parked items come from `docs/gates/phase-26b.md` §8 "For Phase 26c" and the owner calls of 2026-11-07 (§4.3 there). Read the spec section and §8 first.

## Global Constraints

- CLAUDE.md hard rules 1–10, and the user rule: no fallbacks.
  - Rule 3: every hreflang, membership and sitemap question is SQL. Nothing loads `links`, `hreflang`, `sitemap_memberships` or `sitemap_hreflang` into memory.
  - Rule 4: htmlparser2 only, streaming. The sitemap stream never buffers a document; the analyzer additions are tokenizer state.
  - Rule 5: a URL over the index limit is refused by `url-policy` like any other refused URL.
  - Rule 6: RAM O(concurrency). Every new per-page fact is capped. Sitemap memory is O(chunk + one `<url>` entry + one sink batch), never O(document).
  - Rule 7: a rule that cannot judge says so through the marker. A key missing on a v3 row throws "re-crawl", as `imageRefs` and `lost` do in 26b.
- Baseline: `main` @ `e972234` (PR #23 merge), ruleset 0.21.0, **182 rules** (70 page / 98 query / 14 metric; 33 critical / 63 warning / 86 info; 15 markers), migrations 0000–0028, `EXTRACTION_VERSION` 2, **115 files / 3,238 tests green** (`DATABASE_URL` set).
- **One migration, `0029`**, drizzle-kit generated (`npm run db:generate`, applied with `npm run db:migrate`), in Task 1. **`EXTRACTION_VERSION` 2 → 3** and **ruleset 0.21.0 → 0.22.0**, once each, in Task 1. The version note is built up task by task (`// 0.22.0: Phase 26c, …`, items `(Tn)`).
- **End state: 187 rules = 72 page + 101 query + 14 metric; 33 critical / 66 warning / 88 info; 15 markers.** Each task updates the pins to its running totals: `test/rules/coverage.test.ts` (split and narrative), `test/rules/registry.test.ts` (count and severity split), `test/rules/run.test.ts` (id count).

  | New rule | kind | severity | CHECK | Task |
  |---|---|---|---|---|
  | `url.reference-too-long` | page | warning | CHECK-28 | 2 |
  | `social.image-insecure` | page | info | CHECK-87 | 4 |
  | `sitemap.oversized` | query | warning | CHECK-08 | 9 |
  | `sitemap.url-in-multiple` | query | info | CHECK-08 | 9 |
  | `hreflang.source-conflict` | query | warning | CHECK-24 | 10 |

- **One shared URL limit:** `INDEXED_URL_MAX = 2500` (characters of the serialized URL, which is ASCII after `normalizeUrl`), in `src/crawl/parse/url-utils.ts`, with `fitsIndex(url: string): boolean`. Postgres refuses a btree entry over about 2,704 bytes. 2,500 leaves room for `crawl_id` and the tuple header, and stays above the sitemap protocol's 2,048, so `sitemap.url-too-long` still sees 2,049–2,500.
- Every new rule needs, as in 26b:
  - copy in `src/rules/registry/copy/issue-copy.ts` that passes `test/rules/copy.test.ts` (`Area: Condition` title from `AREAS`, one to three sentences, an imperative fix, thresholds quoted from their constant);
  - `columns` in Screaming Frog vocabulary where one exists, every evidence key declared;
  - a `` `rule.id` (severity) `` line in its checklist entry;
  - a positive and a negative test;
  - a fixture page in a new `test/fixtures/pages/authored-p26c.ts`, or a `SKIP_HARNESS_CLAIMS` entry saying why no fixture page can produce it.
- Query rules on v3 facts start with a `v3Gate` (Task 1). Page rules on v3 facts fire only when `extraction_version >= 3`, and a test proves a v2 row is silent.
- No new API or MCP fields (spec "Surface"). The one CSV column in Task 3 is the exception, called out under Deviations.
- `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne` (container `ariadne-pg`). Chromium is installed.
- `page-analyzer.ts` and its oracle test keep their OpenSEO provenance header and gain a "Phase 26c" change paragraph. No re-lift (hard rule 8).
- Commits: conventional, at least one per task, each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The controller updates the Serena memory `roadmap` after each task's commit.

## Deviations from the spec text (owner to see in review)

1. **The parked 26b items join 26c** (owner, 2026-11-07), so 26c bumps extraction to 3. The spec put every parser addition in 26b. A 26b crawl therefore needs one more re-crawl for the v3 rules, and the marker says so.
2. **Header hreflang is parsed at fetch from the full header, not from the stored copy.** The spec says "parsed at write time from the stored header". The stored copy is capped at 2,048 characters (`RESPONSE_HEADER_VALUE_CAP`), so a long `Link` header would lose alternates silently.
3. **An oversized sitemap keeps the URLs read before the cap.** Streaming emits entries as it goes. At 50 MB uncompressed the stream stops, the URLs already read stay (crawled and judged), and `sitemap.oversized` names the document with its bytes read and URLs kept. The copy says search engines reject the whole file. Today the whole document is dropped.
4. **`hreflang.source-conflict` means one language code, different targets.** Sources that disagree on a code's target URL(s) are a conflict. A code that one source lists and another omits is not, because Google unions the sources. The evidence still lists those codes.
5. **`hreflang.multiple-entries` stays per source.** One code with several targets *within one source* is that rule's finding. Disagreement *between* sources is `source-conflict`'s, so one defect never fires both.
6. **The marker `extraction.not-recorded` widens.** It fires when any page is below `EXTRACTION_VERSION` (now 3), or when the crawl's discovery predates 26c (no `discovery.sitemapFacts`). Its evidence gains `requiredVersion` and `sitemapFactsRecorded`, and it claims CHECK-08 and CHECK-28 as well. No new marker.
7. **`sitemap.over-50k-urls` becomes exact** (it counts memberships) and refuses a pre-26c crawl, where it used to give a lower bound. The `sitemap.structure` metric counts `sitemap_doc` rows from memberships when the crawl recorded them, and from `sitemap_urls` otherwise. Its site row gains `docCountsExact` so the reader can tell which.
8. **A link's wider name is stored unresolved for `aria-labelledby`.** Resolving the referenced ids would need the whole document. The stored hint is the id list, and the copy says so.
9. **One URL length limit for every indexed URL column** (`INDEXED_URL_MAX` 2,500). 26b found the crash on `resources`. The same btree limit applies to:
   - `links.target_url`, `hreflang.target_url`, `sitemap_urls.url` and `pages.url`;
   - the new `sitemap_memberships.url` and `sitemap_hreflang.url` / `target_url`.

   An over-long reference is counted, not stored, and reported by `url.reference-too-long`. An over-long share image is reported by `social.image-broken` (problem `too-long`). An over-long `<loc>` is counted in discovery and reported by `sitemap.url-too-long`.
10. **One CSV column added:** `resources` CSV gains `shareImage` (boolean). `crawl_status.resources` keeps counting every `resources` row, because the resource pass fetches share images too. The field docs now say so. No API field is added.
11. **`social.image-insecure` is info.** The owner decided it is flagged, not its severity. No browser loads an `og:image`, so it is not mixed content.

## Review Focus

1. **A sitemap between 10 and 50 MB** (legal today, dropped today) yields every `<url>`, and a 49 MB sitemap moves peak RSS by less than 64 MB (Task 7 unit test on a generated stream; Task 12 probe on a real server).
2. **A URL listed in two sitemaps** is crawled once (one `sitemap_urls` row, first source wins, as today), but it has two `sitemap_memberships` rows and fires `sitemap.url-in-multiple` once. A URL listed twice in *one* sitemap is one membership (Task 8, Task 9).
3. **A `Link` header with commas inside a quoted parameter or the URL** (`<https://x/a,b>; rel="alternate"; hreflang="de"`, `title="a, b"`) parses to the right pairs. A `Link` header on a PDF (non-HTML) page writes `source='header'` rows (Task 6).
4. **A 3,000-character `src`, `href`, hreflang target, share image or `<loc>`** never reaches an insert. The crawl finishes, the count lands in its fact, and the matching rule reports it (Task 2, Task 8).
5. **A pre-v3 crawl** (the stored lavishalice crawl `crawl_4dd32709…`, all v2) gets `extraction.not-recorded` (`requiredVersion: 3`, `sitemapFactsRecorded: false`) and no finding from any v3-gated rule. Rules that read only older facts are unchanged (Task 1 test; re-proved in the Task 12 gate).

---

### Task 0 (controller, no code): 50k baseline on `e972234`

Before Task 1 changes anything, measure the 50k memory gate on the unchanged tree. The gate compares against it.

- [ ] Run `DATABASE_URL=… node --max-old-space-size=512 --import tsx scripts/gate-rules.ts`, under `/usr/bin/time -v` from a script file in the SDD workspace (`baseline-50k/`).
- [ ] Record the overall peak RSS, the per-stage peaks the script prints, and the wall clock in the ledger. If the script has no discovery-stage peak, note that; Task 12 adds one and re-runs the baseline the same way.

### Task 1: Foundations — migration 0029, version bumps, URL limit, v3 gate, marker

**Files:**
- Modify: `src/db/schema.ts`, `src/crawl/versions.ts`, `src/crawl/parse/url-utils.ts`, `src/rules/query/page-facts.ts`, `src/rules/registry/registry.ts`, `src/rules/registry/copy/issue-copy.ts`, `skills/ariadne-audit/checklist.md`
- Create: `drizzle/0029_*.sql` (generated)
- Test: `test/crawl/url-utils.test.ts`, `test/rules/page-facts-query.test.ts` (or the marker's existing test file), `test/rules/registry.test.ts`, `test/rules/coverage.test.ts`

**Interfaces:**
- Produces:
  - `EXTRACTION_VERSION = 3`; `RULESET_VERSION = "0.22.0"`.
  - `INDEXED_URL_MAX = 2500` and `fitsIndex(url: string): boolean` (`url.length <= INDEXED_URL_MAX`) in `url-utils.ts`.
  - `v3Gate(db, crawlId): Promise<{recorded: boolean; atOrAbove: number; below: number}>` in `src/rules/query/page-facts.ts`, beside `v2Gate`. It uses `extractionCoverage(db, crawlId, 3)`.
  - `sitemapFactsRecorded(db, crawlId): Promise<boolean>`, which is true when `crawls.discovery_jsonb` has a `sitemapFacts` key. It throws when the crawl row is missing.
  - Schema (one migration):
    - `links.name_hint text` and `links.name_hint_source text` (both nullable).
    - `resources.share_image boolean not null default false`.
    - `pages.overlong_urls jsonb` (nullable), typed `OverlongUrls = { links: number; resources: number; hreflang: number }`. The type lives in `page-facts.ts`.
    - Table `sitemap_memberships`: `crawl_id` (FK cascade), `url`, `url_normalised` not null, `sitemap_source`. Primary key `(crawl_id, url, sitemap_source)`; index `(crawl_id, url_normalised)`.
    - Table `sitemap_hreflang`: `crawl_id` (FK cascade), `url`, `url_normalised` not null, `hreflang_code`, `target_url`, `sitemap_source`. Index `(crawl_id, url_normalised)`; no unique key.
  - `DiscoverySitemapFacts`, the new `discovery.sitemapFacts` shape, typed where `DiscoveryTruncation` lives:
    ```ts
    type DiscoverySitemapFacts = {
      memberships: number; membershipLimited: boolean;
      hreflangRows: number; hreflangLimited: boolean;
      overlongLocsSkipped: number;
      oversizedDocs: { url: string; bytesRead: number; urlsKept: number }[]; // capped at 50
    };
    ```

- [ ] **Step 1: Failing tests.**
  - `fitsIndex`: true at 2,500 characters, false at 2,501.
  - Marker on a v2-only crawl with `discovery_jsonb` lacking `sitemapFacts`: one site finding, evidence `{pagesNotRecorded: n, pagesRecorded: 0, requiredVersion: 3, sitemapFactsRecorded: false}`.
  - Marker on an all-v3 crawl that has `sitemapFacts`: `[]`.
  - Marker on an all-v3 crawl with no `sitemapFacts`: fires, with `pagesNotRecorded: 0`.
  - `v3Gate` on a mixed v2/v3 crawl: `recorded: false`.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement the schema, run `npm run db:generate` then `npm run db:migrate`, and bump both versions. Widen the marker per Deviation 6: it adds CHECK-08 and CHECK-28 to its claims, its copy names sitemap facts as well as page facts, and it declares the new evidence keys. Add checklist lines for the five new rule ids under CHECK-08, CHECK-24, CHECK-28 and CHECK-87, so coverage stays green as each rule lands. Open the 0.22.0 version note with item (T1).
- [ ] **Step 4:** Run `npx tsc --noEmit` and `npm test`. Green, with the rule count unchanged at 182.
- [ ] **Step 5:** Commit `feat(db): phase 26c schema, extraction v3, the indexed-URL limit and the v3 marker`.

### Task 2: Over-long URLs are refused, counted and reported

**Files:**
- Modify: `src/crawl/url-policy.ts`, `src/crawl/parse/page-analyzer.ts` (`addResource`, `shareImageRef`, the link recorder, the hreflang capture), `src/crawl/parse/page-facts.ts`, `src/crawl/persist.ts`, `src/rules/page/` (the new rule lives beside `url.too-long` in `on-page.ts`), `src/rules/query/social.ts`, copy, registry
- Test: `test/crawl/url-policy.test.ts`, `test/crawl/page-analyzer.test.ts`, `test/crawl/persist.test.ts`, `test/rules/on-page.test.ts`, `test/rules/social-query.test.ts`

**Interfaces:**
- Consumes: `fitsIndex`, `INDEXED_URL_MAX`, `OverlongUrls` (Task 1).
- Produces:
  - `PageAnalysis.overlongUrls: OverlongUrls`, always present on v3 rows, zeros included.
  - `SocialFacts.imageRefTooLong: { og: boolean; x: boolean }`, always present on a v3 social object.
  - Rule `url.reference-too-long` (page, warning, CHECK-28, category `url`).

- [ ] **Step 1: Failing tests.**
  - `url-policy` refuses a 2,501-character URL with a new reason `too_long`, through the same refusal path as the existing reasons.
  - The analyzer, on a page with a 3,000-character link `href`, `<img src>` and hreflang `href`:
    - `overlongUrls` is `{links: 1, resources: 1, hreflang: 1}`;
    - none of the three appears in `links`, `resourceRefs` or `hreflang`.
  - A 3,000-character `og:image` gives `imageRefs.og === null` and `imageRefTooLong.og === true`.
  - Persist round-trip: a page with all four over-long URLs writes without a database error, and the `overlong_urls` column holds the counts.
  - The rule fires on `{links: 1}` with evidence `{links, resources, hreflang, max: 2500}`. It is silent on all zeros and silent on a v2 row (null column).
  - `social.image-broken` reports problem `too-long` for `imageRefTooLong.og`. A v3 social object without `imageRefTooLong` throws "re-crawl".
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement. The check runs after `normalizeUrl` on the resolved URL. A refused reference still counts toward the existing per-page caps (`MAX_RESOURCE_REFS`, `MAX_HREFLANG_PAIRS`), so a hostile page cannot dodge them.
- [ ] **Step 4:** Run the suite and tsc; green. Update the pins to 183 (71/98/14; 33/64/86).
- [ ] **Step 5:** Commit `feat(crawl): refuse URLs too long to index and report them (url.reference-too-long)`.

### Task 3: Share images are named at the source

**Files:**
- Modify: `src/crawl/persist.ts` (share-image push), `src/rules/query/resources.ts` (census `"share-only"`), `src/api/csv.ts` (`resources` view), `src/api/service.ts` (doc comment on `resourceCoverage`), `docs/talos-surface.md`
- Test: `test/crawl/persist.test.ts`, `test/rules/resources-query.test.ts`, `test/api/csv.test.ts`

**Interfaces:** The column `resources.share_image` (Task 1). The CSV header gains `shareImage` after `kind`.

- [ ] **Step 1: Failing tests.**
  - Persist marks a share-image row `share_image = true`.
  - A URL that one page loads as an `<img>` and another uses as `og:image` ends with `share_image = true`, since the flag is set on conflict, plus a `page_resources` edge.
  - The census `"share-only"` counts rows with `share_image and not LOADED_BY_A_PAGE`.
  - The CSV row shows `shareImage` `true` and `referencingPages` 0 for a share-only image.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement. The share-image insert becomes `onConflictDoUpdate`, setting `share_image = true` (only that column). `LOADED_BY_A_PAGE` stays the authority for "loaded". `resourceCoverage` SQL is unchanged; its doc comment, and `crawl_status.resources` in `docs/talos-surface.md`, say share images are counted because the pass fetches them.
- [ ] **Step 4:** Run the suite; green.
- [ ] **Step 5:** Commit `feat(resources): mark share images on the row; CSV shareImage column`.

### Task 4: `og:image:secure_url` and `social.image-insecure`

**Files:**
- Modify: `src/crawl/parse/page-facts.ts` (`SocialTag`, `SocialFacts`), `src/crawl/parse/page-analyzer.ts` (`SOCIAL_SLOTS`, `recordSocialTag`), `src/crawl/parse/page-analyzer.upstream.test.ts` (oracle), `src/rules/page/social.ts`, copy, registry
- Test: `test/crawl/analyzer-extensions.test.ts`, `test/rules/social.test.ts`

**Interfaces:**
- `SocialTag` gains `"og:image:secure_url"`, and `SocialFacts.og` gains key `"image:secure_url"`. This uses the existing first-value, conflict and count machinery. The value is capped at `SOCIAL_URL_MAX`.
- Rule `social.image-insecure` (page, info, CHECK-87, category `on-page`). It fires when:
  - `extraction_version >= 3`;
  - the page URL is `https:`;
  - `og.image` starts with `http:` (case-insensitive);
  - and `og["image:secure_url"]` is absent or does not start with `https:`.

  Evidence is `{ogImage, secureUrl}` (`secureUrl` optional).

- [ ] **Step 1: Failing tests.**
  - Analyzer: `<meta property="og:image:secure_url" content="https://x/a.jpg">` lands in `social.og["image:secure_url"]`, and the oracle agrees.
  - Rule positive: an `https:` page with an `http:` og:image and no secure_url.
  - Rule negatives:
    - an `https:` secure_url silences it (the lavishalice shape);
    - an `http:` page;
    - an `https:` og:image;
    - a v2 row.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite; green. Pins: 184 (72/98/14; 33/64/87).
- [ ] **Step 5:** Commit `feat(social): record og:image:secure_url; flag an http share image on https (social.image-insecure)`.

### Task 5: A link's wider name

**Files:**
- Modify: `src/crawl/parse/page-analyzer.ts` (`OpenAnchor`, the open/close handlers, `ontext` for `<svg><title>`), its oracle, `src/crawl/persist.ts`, `src/rules/query/link-hygiene.ts`, copy, registry
- Test: `test/crawl/page-analyzer.test.ts`, `test/crawl/persist.test.ts`, `test/rules/link-hygiene-query.test.ts`

**Interfaces:**
- `LinkRecord`, the analyzer's link output, gains `nameHint: string | null` and `nameHintSource: "aria-labelledby" | "inner-aria-label" | "svg-title" | "title" | null`.
  - Precedence, highest first, approximating accessible-name order:
    1. `aria-labelledby` on the `<a>` (the trimmed id list, unresolved);
    2. the first non-empty `aria-label` on a descendant element;
    3. the text of a `<title>` inside an `<svg>` inside the link;
    4. the `<a title>` attribute.
  - Capped at `ARIA_LABEL_MAX` with `storableCap`. Only the winning hint is stored.
- `ARIA_LABEL_ABSENT` is joined by `NAME_HINT_ABSENT` (same normalisation on `name_hint`).
  - `links.no-anchor-text`: text empty, the aria-label absent and the name hint absent.
  - `links.aria-label-only`: text empty, and the aria-label or the name hint present. Its evidence `labels` becomes `names: {source, value}[]` (sources `aria-label` plus the four hint sources). The title becomes "Links: Named Only by Attributes"; the id stays.
  - Both rules switch from `v2Gate` to `v3Gate`.
- The `<svg><title>` text is captured only while an anchor is open. It does not change `titleCount` or `titleOutsideHead` (the existing `suppressDepth` guard stays).
- Fix the stale module-header line in `page-analyzer.ts`, "The confirmation rule itself is unchanged." (about line 474). It should say that a `<template>`'s content is neither evidence nor lost (26b review note).

- [ ] **Step 1: Failing tests.**
  - Each of the four hint sources on an otherwise empty link records that source and value.
  - When two are present, the higher one wins.
  - A link with text records no hint.
  - A 500-character hint is capped at 200.
  - `<svg><title>` inside a link leaves the page's `titleCount` unchanged.
  - Persist round-trip of both columns.
  - Rules:
    - a hint-only link moves from no-anchor-text to aria-label-only;
    - a link with nothing still fires no-anchor-text;
    - a v2 crawl gets neither finding.
  - The oracle mirrors the precedence.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite; green. Pins unchanged (184).
- [ ] **Step 5:** Commit `feat(links): read a link's name from aria-labelledby, inner labels, svg titles and title`.

### Task 6: The `Link` header parser and header hreflang

**Files:**
- Create: `src/crawl/link-header.ts`
- Modify: `src/crawl/fetch-page.ts` (`parseCanonicalLinkHeader` reimplemented on the new parser, plus header hreflang on the fetch result), `src/crawl/persist.ts` (`hreflangRows` gains the header source)
- Test: `test/crawl/link-header.test.ts`, `test/crawl/fetch-page.test.ts`, `test/crawl/persist.test.ts`

**Interfaces:**
- `parseLinkHeader(values: string[]): LinkHeaderEntry[]`, where `LinkHeaderEntry = { uri: string; params: Record<string, string> }`.
  - It is an RFC 8288 tokenizer. A `<…>` URI may contain commas. Parameter values may be quoted strings with commas and escaped quotes. Parameter names are lower-cased; `rel` keeps its value.
  - Malformed entries are skipped and counted, as `{entries, malformed}`. The function returns `{ entries: LinkHeaderEntry[]; malformed: number }`.
- `parseCanonicalLinkHeader` keeps its signature and its tests unchanged.
- `FetchResult.headerHreflang: HreflangPair[]`: entries whose `rel` tokens include `alternate` and that have a `hreflang` param. URIs are left as written (resolved at persist, against the final page URL), capped at `MAX_HREFLANG_PAIRS`, and counted in `overlongUrls.hreflang` when they fail `fitsIndex` after resolving.
- Persist writes `source: "header"` rows for **every** fetched page row, HTML or not, from `fetch.headerHreflang`. Unresolvable URIs count in `hreflangUnresolved`, as the HTML path does.
- Over-long header targets are counted at persist, after resolving, and added to the row's `overlong_urls.hreflang`. A non-HTML v3 row gets `overlong_urls = {links: 0, resources: 0, hreflang: n}`, so `url.reference-too-long` covers it too, with a test on a PDF row.

- [ ] **Step 1: Failing tests.**
  - Parser:
    - two entries in one value;
    - entries split across two header values;
    - `<https://x/a,b>; rel="alternate"; hreflang="de"`;
    - `title="a, \"b\""`;
    - `rel=alternate` unquoted;
    - a malformed entry is skipped and counted.
  - Fetch: a response with `Link: <…/de>; rel="alternate"; hreflang="de", <…/en>; rel="alternate"; hreflang="en"` yields two pairs.
  - Persist: a `non_html` PDF page with that header writes two `source='header'` rows.
  - The existing canonical-header tests pass unchanged.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite; green.
- [ ] **Step 5:** Commit `feat(crawl): RFC 8288 Link parser; hreflang from the Link header`.

### Task 7: The streaming sitemap parser

**Files:**
- Create: `src/crawl/sitemap-stream.ts`
- Test: `test/crawl/sitemap-stream.test.ts`

**Interfaces:**
```ts
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024; // protocol limit, uncompressed
export type SitemapUrlEntry = { loc: string; lastmod: string | null; alternates: { hreflang: string; href: string }[] };
export type SitemapStreamResult =
  | { kind: "urlset" | "index"; bytes: number; oversized: boolean; malformedEntries: number }
  | { kind: "refused"; reason: string };
export async function parseSitemapStream(
  body: AsyncIterable<Uint8Array>,
  opts: { maxBytes: number; charset: string | null;
          onUrl: (e: SitemapUrlEntry) => void; onSitemap: (loc: string, lastmod: string | null) => void;
          drain: () => Promise<void> },
): Promise<SitemapStreamResult>;
```
- Gzip: the first two bytes `0x1f 0x8b` select `zlib.createGunzip()`. After one gunzip, a second magic check allows one more round, matching today's two-round limit. `maxBytes` counts **decompressed** bytes, and the stream stops at the cap with `oversized: true`.
- htmlparser2 `Parser` in `{ xmlMode: true }`, fed with `write()` per decoded chunk. Elements are matched on the local name (the part after `:`), so `xhtml:link` and `link` are the same. A `<link rel="alternate" hreflang=… href=…>` inside `<url>` is an alternate, capped at `MAX_HREFLANG_PAIRS` per entry.
- The root element must be `urlset` or `sitemapindex`; otherwise the result is `refused`, with the same reason text today's parser gives. A `<!DOCTYPE` before the root is `refused`, with today's DOCTYPE reason text.
- `<url>` without `<loc>` increments `malformedEntries`, as today.
- After each chunk, `drain()` is awaited, so the caller's sink can flush. Memory is O(chunk + one entry).
- Decoding: `TextDecoder(charset ?? "utf-8", { fatal: false })` with `stream: true`. An unknown charset label is `refused`, never a silent default.

- [ ] **Step 1: Failing tests.**
  - A plain urlset with `xhtml:link` alternates gives entries with alternates.
  - An index yields `onSitemap`.
  - The same documents gzipped once and twice give identical results.
  - A wrong root and a DOCTYPE are refused.
  - A generated **45 MB** urlset (about 300k `<url>`), fed as an async generator, yields every entry. `process.memoryUsage().rss` grows by less than 64 MB during the run (sampled every 1,000 entries).
  - A 51 MB stream stops with `oversized: true` and `bytes` at or near 50 MB.
  - A gzip bomb (a small gzip that inflates past the cap) stops oversized and never holds the inflated document.
  - An unknown charset is refused.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests; green.
- [ ] **Step 5:** Commit `feat(sitemap): stream sitemaps up to the 50 MB protocol limit`.

### Task 8: Discovery on the stream — memberships and staged alternates

**Files:**
- Modify: `src/crawl/discovery.ts` (`fetchDoc` and `parseSitemapDoc` replaced by the stream; `fast-xml-parser` stays only if another caller needs it, otherwise the dependency goes), `src/crawl/loop.ts` (the sink, `persistSitemap`, `discoveryEvidence`), `src/crawl/http.ts` (if `readCapped` loses its last caller, leave it)
- Test: `test/crawl/discovery.test.ts`, `test/crawl/loop.test.ts` (or the discovery persistence test)

**Interfaces:**
- `DiscoverOpts.sink: SitemapSink`, where
  `SitemapSink = { membership(url: string, source: string): void; alternate(url: string, a: {hreflang: string; href: string}, source: string): void; flush(): Promise<void> }`.
  The loop's implementation buffers 500 rows per table, inserts with `storableDeep`, and runs `flush()` from the stream's `drain()`.
  - `sitemap_memberships` inserts with `onConflictDoNothing` on the primary key, so a URL listed twice in one document is one row.
  - `sitemap_hreflang` rows are resolved: `href` against the sitemap URL, `url_normalised` via `normalizeUrl`.
- Caps:
  - `MAX_SITEMAP_MEMBERSHIPS = 800_000`, then `membershipLimited`;
  - `MAX_SITEMAP_HREFLANG_ROWS = 1_000_000`, then `hreflangLimited`;
  - `<loc>`, alternate `href`s and alternate targets that fail `fitsIndex` are skipped and counted in `overlongLocsSkipped`.
- `discovery.sitemapFacts` (Task 1 type) is written on every 26c crawl, even one with no sitemap (zeros).
- `oversizedDocs` takes each oversized document (cap 50). Such a document is **no longer** pushed to `truncation.failures`, so `sitemap.invalid` stops reporting it. `oversizedDocsSkipped` keeps counting oversized documents, for the metric.
- The entry `Map`, the frontier enqueue and `sitemap_urls` (first source wins) are unchanged in behaviour.

- [ ] **Step 1: Failing tests** (against the local test server the discovery tests use).
  - Two sitemaps both list `/a`: one `sitemap_urls` row and two `sitemap_memberships` rows.
  - One sitemap lists `/a` twice: one membership.
  - A urlset with alternates writes `sitemap_hreflang` rows with resolved targets.
  - A 12 MB sitemap (over the old cap) is read whole: no failure, all URLs.
  - A sitemap over the test-lowered cap stops oversized, keeps its earlier URLs, and is in `oversizedDocs`, not `failures`.
  - A crawl with no sitemap writes `sitemapFacts` with zeros.
  - A 3,000-character `<loc>` is counted, not inserted, and the crawl finishes.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement. Keep every existing discovery test green, especially the DOCTYPE, gzip, depth, document-cap and entry-cap behaviours.
- [ ] **Step 4:** Run the suite; green.
- [ ] **Step 5:** Commit `feat(discovery): stream sitemaps; record every membership and sitemap hreflang`.

### Task 9: Sitemap rules

**Files:**
- Modify: `src/rules/query/sitemap-entries.ts`, `src/rules/query/sitemap.ts`, `src/rules/metric/crawl-metrics.ts` (`sitemap.structure`), copy, registry, checklist (CHECK-08 Evaluate)
- Test: `test/rules/sitemap-entries.test.ts`, `test/rules/sitemap.test.ts`, `test/rules/crawl-metrics.test.ts`

**Interfaces:**
- `sitemap.oversized` (query, warning, CHECK-08). One finding per `oversizedDocs` entry, evidence `{sitemapUrl, bytesRead, urlsKept, max: SITEMAP_MAX_BYTES}`. It is silent, by refusal, when `sitemapFacts` is absent (the marker speaks).
- `sitemap.url-in-multiple` (query, info, CHECK-08). One finding per URL with more than one distinct `sitemap_source` in `sitemap_memberships`, with evidence `{url, sitemaps: string[] (capped 10), count}`. It is a listing (`limitTo(caps.listing)`, `count(*) over ()`, `noteTruncation`), and it adds `membershipLimited: true` to its evidence when the cap was hit. It refuses without `sitemapFacts`.
- `sitemap.over-50k-urls` counts `sitemap_memberships` grouped by `sitemap_source` (exact). It refuses without `sitemapFacts`. The comment saying it is a lower bound goes.
- `sitemap.url-too-long` also reports `overlongLocsSkipped`: one site finding with `{skipped, max: INDEXED_URL_MAX}` when it is above 0.
- `sitemap.structure` follows Deviation 7. Its site row also gains `membershipLimited`, `hreflangLimited` and `overlongLocsSkipped` (declared in the metric table).

- [ ] **Step 1: Failing tests.** Seed the discovery JSON and the rows directly.
  - Each rule fires and stays silent as defined.
  - On a crawl without `sitemapFacts` (pre-26c), the two new rules and over-50k return `[]`, and the marker fires.
  - over-50k counts a URL listed in two documents once per document.
  - `sitemap.invalid` no longer lists an oversized document from a 26c crawl, but still lists one from an old crawl's `failures`.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite; green. Pins: 186 (72/100/14; 33/65/88).
- [ ] **Step 5:** Commit `feat(rules): sitemap.oversized and sitemap.url-in-multiple; exact 50k counts`.

### Task 10: Sitemap hreflang into `hreflang`, all-source rules, `hreflang.source-conflict`

**Files:**
- Create: `src/rules/derive/sitemap-hreflang.ts`
- Modify: `src/rules/run.ts` (`derivations`), `src/rules/query/hreflang-integrity.ts` (`DECLARATIONS`), `src/rules/query/hreflang.ts` (evidence `sources` everywhere it lists declarations), copy, registry, checklist (CHECK-24: rule line, plus the Evaluate line "WARN if hreflang only in sitemap", which now reads the `sources` evidence)
- Test: `test/rules/derive-sitemap-hreflang.test.ts`, `test/rules/hreflang-integrity.test.ts`, `test/rules/hreflang-query.test.ts`

**Interfaces:**
- `deriveSitemapHreflang(db, crawlId): Promise<{rows: number}>`. It is idempotent: it deletes this crawl's `hreflang` rows with `source = 'sitemap'`, then inserts from `sitemap_hreflang` joined to `pages` on `(crawl_id, url_normalised)`. It sets `page_id = p.id`, copies code and target, and sets `source = 'sitemap'`, all in one SQL statement. Staged rows for uncrawled URLs stay staged.
- `DECLARATIONS` reads every source:
  - it groups on `(page_id, lower(replace(code,'_','-')), target_url)` with `array_agg(distinct source) as sources`;
  - `hreflang.multiple-entries` counts distinct targets per code **within one source** (Deviation 5);
  - the other integrity rules read the union.
  - Rules in `hreflang.ts` were already unfiltered; their evidence gains `sources` where it lists a declaration.
- `hreflang.source-conflict` (query, warning, CHECK-24). It fires on a page annotated by at least two sources where some normalised code maps to different target sets in two sources. Evidence:
  - `{code, bySource: {source, targets: string[]}[]}`, for the first conflicting code;
  - `conflictingCodes` (count);
  - `onlyIn: {source, codes: string[]}[]`, informational, capped.

  It is a listing with the 26a idioms. It opens with `v3Gate` and `sitemapFactsRecorded`, and refuses if either is false.

- [ ] **Step 1: Failing tests.**
  - Derivation:
    - staged rows for a crawled URL become `source='sitemap'` rows tied to the page;
    - a second run gives the same row count;
    - an uncrawled URL writes nothing.
  - `source-conflict` positive: HTML `de → /de/`, sitemap `de → /de-de/`.
  - `source-conflict` negatives:
    - same targets from header and HTML;
    - the sitemap lists `fr`, which the HTML lacks (only `onlyIn`);
    - a single source.
  - `multiple-entries`: two `de` targets in one source fire it; one target in each of two sources does not.
  - `missing-return-link` is satisfied by a sitemap-sourced return link.
  - A v2 crawl gets no `source-conflict` finding.
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite; green. Pins: **187 (72/101/14; 33/66/88)**.
- [ ] **Step 5:** Commit `feat(hreflang): sitemap and header sources in every hreflang rule; hreflang.source-conflict`.

### Task 11: Surface, skills, fixtures, harness

**Files:** `docs/talos-surface.md` (the new ids, counts, `rules_catalog` bytes, the CSV column), `skills/ariadne-audit/SKILL.md`, `skills/ariadne-report/SKILL.md`, `skills/ariadne-audit/checklist.md` (final pass), `test/fixtures/pages/authored-p26c.ts`, `test/fixtures/harness.test.ts` (pins and `SKIP_HARNESS_CLAIMS`), the fixture site's sitemap (a second sitemap listing one URL twice, and `xhtml:link` alternates on two pages)

- [ ] **Step 1:** Add fixture pages for:
  - `url.reference-too-long`;
  - `social.image-insecure`;
  - a hint-only link;
  - a `Link`-header hreflang page that conflicts with its HTML.

  `sitemap.oversized` gets a `SKIP_HARNESS_CLAIMS` paragraph: a 50 MB fixture is out of proportion, and Task 7 and 8 prove it.
- [ ] **Step 2:** Run the harness, read every new or changed finding, and pin it. If an existing `exact` fixture trips, read the page. Add the id only for a real defect; never loosen a rule.
- [ ] **Step 3:** Update the surface docs and skills. The `rules_catalog` size is measured, not estimated.
- [ ] **Step 4:** Run the full suite and tsc; green.
- [ ] **Step 5:** Commit `docs(surface): phase 26c rules, counts and the shareImage column; fixtures`.

### Task 12: Gate 26c

Outputs go in the SDD workspace (`gate26c/`, git-ignored). The write-up goes in `docs/gates/phase-26c.md`, in the 26b gate doc's shape (clause table, then one section per clause).

1. **Suite.** `npm test` green, 0 skipped; `npx tsc --noEmit` clean.
2. **Pre-bump crawl.** Re-judge the stored lavishalice crawl `crawl_4dd32709-56c9-4a62-9af4-7a843f76ff6c` (v2, no `sitemapFacts`). Expected:
   - the marker shows `requiredVersion: 3` and `sitemapFactsRecorded: false`;
   - 0 findings from:
     - the v3-gated rules: `links.no-anchor-text`, `links.aria-label-only`, `hreflang.source-conflict`, `url.reference-too-long`, `social.image-insecure`, and `social.image-broken` on v2 rows;
     - the three refusing sitemap rules;
   - every other rule's findings byte-identical to its pre-26c judgement.

   The diff is the proof, the same method as 26b clause 2.
3. **50k memory gate.**
   - Re-run Task 0's command on the final code. Add a discovery-stage RSS peak to `scripts/gate-rules.ts` if it lacks one, and re-run the baseline with it.
   - Peak RSS ≤ 512 MB, and the discovery-stage peak no higher than the baseline's (tolerance: run-to-run noise measured by two baseline runs).
   - Then run once with the fixture sitemap carrying `xhtml:link` alternates. Add a `GATE_SITEMAP_HREFLANG=1` switch to `test/gate/site-server.ts`, default off so the comparison above is like for like. Record its peak.
4. **50 MB probe.** A script streams a generated 49 MB sitemap from a local server through `discover`. It records peak RSS delta (≤ 64 MB) and the URL count (all).
5. **Hurtigruten crawl. The controller asks the owner before running it.**
   - Settings: `siteUrl: "https://www.hurtigruten.com/en/"`, `sitemapUrls: ["https://www.hurtigruten.com/en/sitemaps/en/sitemap.xml"]`, `allowedDomains: ["hurtigruten.com"]`, `maxPages: 600`, `fetchResources: false`. Polite defaults: robots, crawl-delay, the governor.
   - Verify:
     - `sitemap_hreflang` rows ≈ 6,335;
     - `hreflang` `source='sitemap'` rows exist for crawled pages;
     - the HTML and header sources, as present;
     - `sitemapFacts`.
   - Review every finding of the five new rules and the widened hreflang rules for false positives: hand-check samples against the live site, with at most 40 GETs, 3 s apart.
6. **Write-up.** Gate doc, ledger, Serena memory. Every count in the doc comes from a saved output file.

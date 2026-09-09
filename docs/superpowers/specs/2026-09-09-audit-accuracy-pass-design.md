# Audit accuracy pass: design (Phase 19)

Date: 2026-09-09. Owner's words, after reading the findings on a real crawl
(`crawl_9c9292c7`, lavishalice.com, 494 pages, ruleset 0.13.0): "I think it
needs another pass, also on the issue description, solutions." Four complaints,
each traced to a defect on our side, plus two more the same crawl exposed.
Owner approved this plan ("go").

Ruleset 0.13.0 → **0.14.0**. Migration **0018**. The bump is done ONCE, by the
orchestrator, after every task below lands; no task bumps it.

---

## 1. Duplicates ignore the canonical (false positive)

**Observed.** Both `content.exact-duplicate` findings are one page under a
parameter (`/collections/sale` vs `?product-type=dress`; `/pages/email-signup`
vs a `?srsltid=` Google tracking variant). Each variant declares
`<link rel=canonical>` to the base URL. The rule groups by `content_hash` over
auditable pages and never reads the canonical, so it reports as critical the
situation its own `howToFix` prescribes.

**Decided.**

- A page whose declared canonical (`canonical_html`, else `canonical_header`)
  is present and is not its own URL is **canonicalised elsewhere**. One helper
  in `src/rules/helpers.ts` says so (`CANONICALISED_ELSEWHERE(alias)` as SQL and
  `isCanonicalisedElsewhere(page)` in TypeScript), stated once and used by every
  rule below.
- `content.exact-duplicate` excludes canonicalised-elsewhere pages from its
  groups. A group that shrinks below two members is not a finding.
- `content.near-duplicate` excludes them from both sides of a pair.
- The exclusion is by declared canonical only. Whether the canonical target is
  itself sound is `canonical.*`'s business and already reported there.

## 2. Near-duplicate measures the chrome (noise)

**Observed.** 500 findings (capped), 237 across unrelated templates, hamming 1
to 2. The smallest page on the site has 916 words and the median 1,064: about
900 words on every page are header, navigation and footer. `simhash` is
computed over the whole visible text, so two pages with 150 words of their own
look identical.

**Decided.**

- The analyser computes a second fingerprint over the **main content**:
  the text inside `<main>` when the page has one; otherwise the visible text
  with `<nav>`, `<header>`, `<footer>` and `<aside>` subtrees removed. Same
  streaming pass, depth counters on the existing `navDepth` idiom (hard rule 4:
  no DOM). Two new analyser outputs: `mainSimhash` (bigint, same signed
  spelling as `simhash`) and `mainWordCount`. Both `null` when the page has no
  main-content text at all (an empty `<main>`, or a body that is nothing but
  chrome); `null` is "nothing to fingerprint", never `0`.
- The cheerio parity oracle (test/crawl/parse) computes the same two numbers
  from the DOM and must agree.
- Migration 0018: `pages.main_simhash bigint`, `pages.main_word_count integer`,
  both nullable; null on every pre-0018 row (no backfill).
- `content.near-duplicate` reads `main_simhash` and requires
  `main_word_count >= 50` on BOTH pages (a page with less than that has no
  content to be a near-duplicate of; `content.thin` owns it). Hamming threshold
  stays 3 of 64.
- **Older crawls.** A crawl with no `main_simhash` (crawled before 0018)
  cannot run this check. It does not silently pass: a new NOT MEASURED marker
  `content.near-duplicate-skipped` (info, `marker` flag, CHECK-83 family list)
  fires once with the reason "crawled before the main-content fingerprint
  existed; re-crawl to measure". Hard rule 1.
- The exact-duplicate rule keeps the whole-text `content_hash`: byte-identical
  bodies are identical regardless of chrome.

## 3. Placeholder evidence says nothing (true positive, unusable)

**Observed.** `content.placeholder` fired on three blog URLs with 1,000+ words
and evidence `{wordCount}`. The hit is real: the post's excerpt and its
`description` meta are "Lorem ipsum dolor sit amet…", shown on the blog listing
and in every related-post card. The reader could not see that.

**Decided.** The analyser records `placeholderSnippet`: up to 160 characters of
visible text around the first "lorem ipsum" match (the sentence it sits in,
whitespace-normalised). Migration 0018: `pages.placeholder_snippet text`,
nullable, null when `has_lorem_ipsum` is false. The finding's evidence carries
`snippet`. Copy states what was matched and where a reader will find it.

## 4. Hreflang: canonicalised pages, self-reference, and the alternates nobody crawled

**Observed.** Both `hreflang.missing-return-link` findings are the two
canonicalised parameter pages from §1: they inherit the template's hreflang
block, which names the base URL as `en`/`x-default`; the base does not point
back at a tracking variant. Site-wide: 376 pages declare 7-code clusters;
2,632 alternates; 1,880 of them on five other hosts (`.ae .au .ca .ie .us`),
none crawled. The return-link rule reads back-links only from crawled targets
and says nothing about the rest, which is an always-passes hole for exactly the
case hreflang exists for.

**Decided.**

- All hreflang rules skip canonicalised-elsewhere pages (§1 helper). Search
  engines evaluate hreflang on the canonical only.
- New rule `hreflang.missing-self-reference` (warning, the same checkIds
  as `hreflang.missing-return-link`): an auditable, non-canonicalised page that declares alternates but
  whose own URL is not among them. Evidence: the codes declared and the URL
  the page's own language code points to instead, when there is one.
- New NOT MEASURED marker `hreflang.alternates-not-crawled` (info, `marker`
  flag, CHECK-83 family list): fires once per crawl when any declared
  alternate has no page row, with evidence `{hosts: [{host, alternates,
  pages}], total}` grouped by target host. Reason text: "N alternates on M
  host(s) outside this crawl were not fetched, so their return links and
  indexability could not be checked". Off-host alternates are the normal case
  for a multi-market site, so this marker will fire on most international
  sites; that is the point.
- `hreflang.missing-return-link` keeps firing only where the target WAS crawled
  and does not point back. Its copy says so.

## 5. "Returns an error" (definition)

**Observed.** `links.broken-internal` fires on `fetch_class = 'client_error'`
only; all 91 findings are 404s. The title says "returns an error". Nothing
reports internal links to a 5xx page.

**Decided.**

- `links.broken-internal` title: "Internal links point to a page that answers
  4xx (not found, gone, forbidden)". Explanation defines 4xx as the client
  error class and names the common members with what each means. Evidence
  already carries `statusCode`; the row shows it.
- New rule `links.to-server-error` (critical, same check id as
  `links.broken-internal`): internal links whose target answered 5xx
  (`fetch_class = 'server_error'`). Same shape and evidence as its sibling.
  It reports the LINK, `http.server-error` reports the PAGE; both fire on a
  5xx page that is linked to, and that is correct: two facts.

## 6. "Not checked" is defined nowhere (copy)

**Observed.** The section's heading and its empty-state sentence assume the
reader knows what a NOT MEASURED marker is. Marker reasons and explanations use
engine words ("pass", "census", "marker", "probe").

**Decided.**

- The demo section: heading "Not checked on this crawl", then one sentence
  ALWAYS shown, above the rows or the empty-state line: "A check is 'not
  checked' when the engine could not answer it on this crawl: a setting this
  crawl ran with, a limit it reached, or something the site did that made the
  question undecidable. Each row names the check and the reason. Nothing here
  is a site problem."
- Every marker's `marker` reason string (the per-row "Not measured: …") is
  rewritten to a plain sentence a client can read, naming the cause AND what
  would answer the check (re-crawl with X on; raise the page limit; fix the
  robots.txt).

## 7. The copy pass (all rules)

Every entry in `src/rules/registry/copy/issue-copy.ts` is rewritten where it
fails the rubric, and left alone where it passes:

1. **Title** states the exact condition, with its threshold or status class
   when one exists ("Title longer than 60 characters", not "Title too long";
   "answers 4xx", not "returns an error"). No engine words.
2. **Explanation** says, in this order: what was measured (the fact), what the
   consequence is for search or for visitors, and any limit of the measurement
   a reader must know ("this compares visible text, not rendered layout").
3. **How to fix** is a concrete action a developer or content owner can take,
   with the pattern-level fix named for templated sites.
4. **No engine vocabulary** in any client-facing string: "marker", "pass",
   "census", "probe", "frontier", "auditable", "NOT MEASURED", "row" are
   banned; the rubric test greps for them.
5. Markers say plainly that nothing is asserted about the site.

A test pins the banned-word list against every title/explanation/howToFix and
every `marker` string (hard rule 10's "coverage is a CI query", applied to
copy).

## 8. Not changed

- `content_hash` and `simhash` keep their meaning; nothing is backfilled.
- The severity assignments of existing rules (Phase 16's rubric).
- Politeness, url-policy, the crawl loop (the analyser change is inside the
  existing single pass).
- `url.tracking-params-internal`'s parameter list: `srsltid` is a Google
  Merchant parameter Google itself appends; internal links carrying it are
  rare and this crawl had one. Left for a later ledger entry.

## 9. Tasks

| task | scope | files (disjoint from siblings run in parallel) |
|---|---|---|
| T1 | analyser: `mainSimhash`, `mainWordCount`, `placeholderSnippet`; migration 0018; writer | `src/crawl/parse/page-analyzer.ts`, `src/crawl/parse/simhash.ts` (only if needed), `src/db/schema.ts`, `drizzle/`, `src/crawl/persist.ts`, `test/crawl/parse/**`, `test/db/migration-0018.test.ts`, `test/crawl/persist.test.ts`, `test/rules/mk-page.ts` |
| T3 | hreflang: canonicalised exclusion, self-reference rule, alternates-not-crawled marker | `src/rules/query/hreflang.ts`, `test/rules/hreflang-*.test.ts`, its entries in `issue-copy.ts` and `checklist.md` |
| T4 | links: 4xx definition, `links.to-server-error` | `src/rules/query/link-targets.ts`, `test/rules/link-targets-query.test.ts`, its entries in `issue-copy.ts` and `checklist.md` |
| T2 (after T1) | content: canonical exclusion, main-content near-duplicate + skipped marker, placeholder snippet; the shared helper | `src/rules/helpers.ts`, `src/rules/query/content.ts`, `src/rules/page/on-page.ts`, `test/rules/content-query.test.ts`, `test/rules/on-page.test.ts`, `test/rules/helpers.test.ts`, its entries in `issue-copy.ts` and `checklist.md` |
| T5 (after T2–T4) | the copy pass, the banned-word test, marker reason strings, the demo section sentence | `issue-copy.ts`, every rule file's `marker` string, `src/demo/index.html`, `test/rules/copy.test.ts`, `test/demo/flow.test.ts` |
| T6 (orchestrator) | ruleset 0.14.0, registry shape test, checklist drift, talos-surface, gate doc, re-judge `crawl_9c9292c7`, before/after table | |

T1, T3 and T4 run in parallel. `issue-copy.ts` and `checklist.md` are touched by
T3 and T4 concurrently in different regions: each re-reads before every edit
and keeps its edits surgical.

## 10. Gate

- Full suite green, tsc clean, migrations 0018 and 0019 applied. (0019 was not
  foreseen when this was written: moving the near-duplicate join onto
  `main_simhash` left 0004's four band indexes on `simhash`, so every band
  predicate matched nothing and the whole `BitmapOr` collapsed to a sequential
  scan. 0019 puts the same four bands on `main_simhash`;
  `test/db/migration-0019.test.ts` holds the plan.)
- Ruleset 0.14.0; the registry shape test records the new totals.
- `crawl_9c9292c7` re-judged at 0.14.0: `content.exact-duplicate` 0,
  `hreflang.missing-return-link` 0, `hreflang.missing-self-reference` 0 (the
  only two pages omitting themselves are the canonicalised variants, which are
  invisible to hreflang entirely — corrected at build time),
  `hreflang.alternates-not-crawled` 1 (5 hosts, 1,870 distinct alternates),
  `content.near-duplicate-skipped` 1 (pre-0018 crawl), `links.broken-internal`
  91 with the 4xx title. A fresh crawl of the same site at 0018 shows the
  near-duplicate count with the main-content fingerprint, recorded beside the
  old 500.
- The banned-word test green over all 100 rules (96 + 4 new).

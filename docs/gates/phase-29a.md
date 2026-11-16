# Phase 29a gate: structured data

Date: 2026-11-16. Spec: `docs/superpowers/specs/2026-11-12-phase-29-checks-wave-2-design.md`
(§29a, its "29a amendment (2026-11-16, owner)", and "Gates" 29a, clauses 1 to 4). Plans:
`docs/superpowers/plans/2026-11-13-phase-29a-structured-data.md` (Tasks 1–11) and
`docs/superpowers/plans/2026-11-16-phase-29a-standards-rework.md` (R1–R5). Branch
`worktree-phase-29`, built on `c2b6c47` (main) plus the design (`bbe9eb0`).

**Benchmark.** Structured data is judged against schema.org and the JSON-LD, Microdata and
RDFa specs, and nothing else. The owner reversed the first build's search-engine profiles
after its gate (2026-11-16): the engine reports facts about the markup for every consumer,
search engines and agents alike, and the agent does the judging. §5 records what that
reversal removed and why the first gate's clause 2 no longer stands.

Code under test: `b1cc36a`. That is Tasks 1–11, their final-review fix wave, the gate fix
`63091e5` (§3), and the rework: `65e87b0`..`cc29000` (R1–R3 and two review rounds), `332f544`
(R4), `ec7b458` (R5 docs), `fd36860`/`e47f248` (multi-type nodes, found by this gate, §2.4),
`3986f9c` (final-review fix wave) and `b1cc36a` (re-review follow-ups).

**Verdict: all four clauses pass**, with one recorded gap: validator.schema.org was not
compared on three of the twenty sampled pages (§2.3).

- **Clause 1:** every `schema.*` rule fires on the fixture site exactly the number of times the
  fixtures call for, and the clean pages fire nothing.
- **Clause 2:** the rules were re-run on the simpleerb.com crawl. All 187 `schema.empty-value`
  findings are true against the live page source; there are no `schema.unresolved-reference`
  findings. A 20-page sample over 14 page types matches the page source node for node and
  property for property (**0 mismatches**, after the multi-type fix this gate called for), and
  matches validator.schema.org on 17 of the 20; the validator was not compared on the fixed
  `/pricing/` row or two other pages, because it began refusing requests (§2.3).
- **Clause 3:** the 50k gate on `b1cc36a` peaks at **276.3 MB** against the local bound of
  290.2 MB.
- **Clause 4:** `test/rules/coverage.test.ts` is green.

The full suite on `b1cc36a` is 184 files and 4,933 tests, all green, and `npx tsc --noEmit` is
clean.

All gate runs used a database made for them, `ariadne_gate29a`, on the dev container
(`create database ariadne_gate29a`, then `npm run db:migrate`: 55 migrations applied, 55 journal
entries). The gate never connected to the dev database `ariadne`. `ariadne_gate29a` is kept;
dropping it waits for the owner's OK.

## 1. Clause 1: the fixture site

`test/fixtures/pages/authored-p29a.ts` carries 19 pages, every one `exact: true`:

- nine single-rule pages: parse-error, unknown-type, unknown-property,
  pending-or-superseded, embedded-type-mismatch (a Book whose `author` is an Offer),
  **empty-value** (`""`, whitespace-only text, `[]`, a typed node with no properties, and the
  nested `$.offers.price`) and **unresolved-reference** (a `#author` defined in a second script
  block on the same page, which resolves; a relative `#series` nobody defines; an absolute IRI
  on another site);
- a clean microdata Product and a clean RDFa Organization;
- a ten-page template (`/authored29a/tpl/1`–`10`) whose tenth page drops the Product that the
  other nine carry, so `schema.template-inconsistent` fires once.

`/authored3/product-partial` (formerly `product-incomplete`) is now a clean control.

`test/fixtures/harness.test.ts`, "each schema.* rule wrote exactly the findings the fixtures call
for (Gate 29a clause 1)", pins the crawl-wide count per rule with `toEqual`. An extra rule or a
missing key fails the test.

| rule | findings | from |
|---|---|---|
| `schema.parse-error` | 1 | its `/authored29a/` single-rule page |
| `schema.unknown-type` | 1 | the same |
| `schema.unknown-property` | 1 | the same |
| `schema.property-pending-or-superseded` | 1 | the same |
| `schema.embedded-type-mismatch` | 1 | the Book page |
| `schema.empty-value` | 1 | the empty-value page (five problems, at their dotted paths) |
| `schema.unresolved-reference` | 1 | the unresolved-reference page (two problems; `#author` resolves) |
| `schema.template-inconsistent` | 1 | `/authored29a/tpl/10` |
| `schema.self-serving-reviews` | 1 | `/authored3/reviews` |
| `schema.breadcrumb-absent` | 1 | site-scoped: the fixture carries no BreadcrumbList |
| `schema.none-on-site` | 0 | the site carries markup |

The harness also pins the `schema.property-coverage` metric rows, hand-derived from the markup
(20 top-level nodes, 13 of them Products). `SKIP_HARNESS_CLAIMS` stays at 26 entries.

## 2. Clause 2: the live crawl, re-judged by web standards

### 2.1 Which site

The owner first named greenpeople.co.uk, a Shopify store (2026-11-16). Cloudflare blocked both
attempts at the first request:

- `crawl_b282e851-…`, AriadneBot UA: the homepage returned 403 and was recorded as a classified
  `blocked (403) after 3 attempts, spacing reached 1000ms` row; `/sitemap.xml` returned 403.
  robots.txt was read.
- `crawl_f9f5af9a-…`, run at the owner's direction with a Googlebot user-agent string: the same
  result.
- One diagnostic request returned 403 with a 5,529-byte body titled `Just a moment...`. That is
  a managed JavaScript challenge, which no non-browser client passes, and the CDN verifies that
  crawler by IP. The challenge was not solved or bypassed.

The owner then named **simpleerb.com**, a non-e-commerce software site, with the direction that
"the crawler should not be tailored for eccomerce only". greenpeople.co.uk, with a Shopify
crawler signature, is an open follow-up (§7).

### 2.2 The crawl and the re-judgement

`crawl_8b55e8e6-9802-4417-ad80-720352d9b13b`, crawled at `63091e5` with the AriadneBot UA,
`maxPages` 1,000, the default politeness (robots.txt, crawl-delay, 1 s per host) and
`fetchResources: false`: 753 pages, 0 failed, 274 sitemap entries. Extraction did not change in
the rework (`EXTRACTION_VERSION` 4), so the clause re-judges the same stored blocks: the rules
were re-run at `b1cc36a` from the database, with no fetch
(`.superpowers/sdd/2026-11-13-phase-29a-structured-data/rerun-rules.mts`, which refuses any
database other than `ariadne_gate29a`). 3,490 findings in all.

- 416 structured-data blocks, all JSON-LD (no microdata or RDFa on the site), every one
  validated; no orphan blocks:

  | stated type | blocks |
  |---|---|
  | BlogPosting | 199 |
  | BreadcrumbList | 107 |
  | FAQPage | 44 |
  | Organization | 42 |
  | HowTo | 19 |
  | SoftwareApplication + FAQPage (one node, two types) | 2 |
  | Corporation | 2 |
  | TechArticle | 1 |

- `schema.*` findings:

  | rule | findings |
  |---|---|
  | `schema.empty-value` | 187 |
  | `schema.parse-error` | 24 |
  | `schema.template-inconsistent` | 16 |
  | `schema.unresolved-reference` | 0 |

- `schema.property-coverage` counts 354 nodes on the judged pages (fetched 200 OK, indexable,
  not canonicalised to another URL): BlogPosting 199, BreadcrumbList 76, FAQPage 35,
  Organization 25, HowTo 16, SoftwareApplication 2, Corporation 2, TechArticle 1;
  `otherVocabularyNodes` 0. The other 62 blocks sit on 31 pages canonicalised to another URL
  (`?ref=` duplicates, FAQ pages whose canonical differs in case). This was checked with the
  engine's own cohort filter, not by hand.

### 2.3 Every finding against the source, and the 20-page sample

**Every `schema.empty-value` finding is true.**

- 185 are BlogPosting `$.image`. In the stored blocks, 199 BlogPostings carry 185 with
  `"image": ""`. All 185 pages were re-fetched live (one request every 1.5 s, branded UA): each
  has one BlogPosting whose `image` is the empty string. 185 of 185.
- `/support/faq/what-are-the-benefits-of-sms-credits-in-simpleerb/`: `$.mainEntity[0].acceptedAnswer.text`
  is `""` and `$.mainEntity[1].name` is `""`. Both are in the live source.
- `/support/guides/booking-options-payment/`: HowTo `$.step` is `[]`. It is in the live source.

There are no `schema.unresolved-reference` findings to check: the site's markup uses no bare
`@id` references.

**The 20-page sample.** One to three pages per page type over 14 page types that carry markup,
including the three pages above and a BlogPosting whose image is present. For each page,
Ariadne's stored top-level nodes (types and property names) were compared with:

- the live page source's JSON-LD, parsed independently: **20 of 20 match**;
- validator.schema.org's extraction, on the properties that carry a value: **17 of 20 match,
  and none of the three others is a mismatch against the fixed code**. The validator leaves an
  empty value out (an empty JSON-LD array yields no triples), which is why that comparison uses
  valued properties; Ariadne reports those as empty values instead, which is the rule's
  purpose. On the first run, at `332f544`, the validator answered for 18 pages: 17 matched, and
  `/pricing/` differed only by the multi-type defect it shares with the source comparison
  (§2.4). Its 19th request was answered with a rate-limit interstitial asking for a CAPTCHA,
  and so were two retries after the fix. It was not solved or bypassed. So the fixed
  `/pricing/` row, `/venues/chains-groups/` and `/venues/entertainment/` have no validator
  comparison; all three match the page source.

The scripts and their outputs are in
`.superpowers/sdd/2026-11-16-phase-29a-standards-rework/clause2-evidence/` (git-ignored, kept
until merge): `compare-sample.mjs`, `check-empty-image.mjs`, the sample and node exports, and
the comparison results.

### 2.4 The mismatch this gate found

The first sample run, at `332f544`, found one mismatch: `/pricing/` carries a node typed
`["SoftwareApplication", "FAQPage"]`, and Ariadne listed it as `SoftwareApplication` only. Its
validator recorded one type per node, the most specific of the known types, and two unrelated
types fall back to the first. Applicability checks already used every type, so no finding was wrong, but FAQPage was
missing from the node listing and the coverage metric.

- `fd36860`: each node keeps its primary `type` and gains `types`, every stated type in authored
  order. The listing exposes it. `schema.property-coverage` counts a node once under each type.
- `e47f248`: the type list is capped like the property list (`typesCapped`).
- `3986f9c` (final review I2): the listing row's page types, the CSV Schema Type and
  `schema.template-inconsistent` read the same stated types.

After the fix the stored node reads `["SoftwareApplication", "FAQPage"]` and the sample matches
20 of 20 against source. Microdata `itemtype` and RDFa `typeof` keep only their first type at
extraction 4. That is an extraction limit, documented, and parked for extraction 5 (§7).

### 2.5 The other findings, checked (not gated)

- **`schema.parse-error`, 24.** All are `/blog/tag/*` pages. Each carries three
  `<meta itemprop="name|image|description">` with no enclosing `itemscope`, legacy snippet tags.
  That is invalid microdata per the WHATWG HTML Microdata rules, and the counts are true.
- **`schema.template-inconsistent`, 16.** These are blog pagination pages (`/blog/10/`…) that
  page-type inference groups with the posts as `/blog/:slug`. They are true to the data but
  misleading to a reader. This is an open item (§7).

## 3. Clause 3: the 50k gate

`scripts/gate-rules.ts` runs crawl, render and rules over the 50,000-page fixture in one
process. That is the measure behind the 290.2 MB local bound (27d, 28c).

| run | head | crawl | peak (crawl / render / rules) | rules wall | findings | result |
|---|---|---|---|---|---|---|
| first build, 1 | `777d28f` | `crawl_dbb15457-…` | 281.8 / 283.3 / 284.2 MB | 406.5 s | 155,649 | passed |
| first build, 2 | `25dcb68` | `crawl_5afec783-…` | 290.2 / 290.2 / — | — | — | **threw** (below) |
| first build, 3 | `63091e5` | `crawl_e710f626-…` | 278.7 / 226.4 / 271.3 MB | 417.3 s | 155,649 | passed |
| **rework** | **`b1cc36a`** | `crawl_b4abee33-…` | **276.3** / 227.5 / 272.9 MB | 438.0 s (derivations 36.5 s) | 155,249 | **GATE PASSED** |

The rework run's findings differ from run 3's by exactly the 400 findings of the two removed
search-engine rules (200 each); every other rule's count is the same on both crawls, and the new
`schema.empty-value` and `schema.unresolved-reference` fire nothing on the 50k fixture. The
rules wall grew by 20.7 s (5%) over run 3; the cause was not isolated (the template rule now
reads the stored verdicts, and the derivations themselves ran faster). The log and JSON are
`.superpowers/sdd/2026-11-16-phase-29a-standards-rework/gate-rules-rework-1.{log,json}`.

**The first build's 50k run found a real defect.** Its second run, at `25dcb68`, threw:

```
schema.unknown-type: …/products/p0 structured data has no validation — re-run the rules
```

The derivation selected `id::text as id … order by id`. Postgres binds a bare `ORDER BY id` to
the text output column, so rows sorted lexically ("100000" < "80001") while the cursor advanced
numerically. Any database past 99,999 `structured_data` rows would have refused every rules run.
`63091e5` orders by the qualified column and adds an end-of-derivation count check that names
the crawl, with a regression test across a power of ten.

## 4. Clause 4: coverage

`test/rules/coverage.test.ts` is green on `b1cc36a`. `schema.empty-value` and
`schema.unresolved-reference` claim CHECK-43 with the other per-node rules;
`schema.property-coverage` claims CHECK-44. The registry is 197 rules: 72 page, 110 query and
15 metric; 33 critical, 71 warning and 93 info (pinned by a test). `RULESET_VERSION` stays
`0.26.0`, unshipped, with a dated line naming the rework.

## 5. What did not go as first written

- **The first build judged markup by one search engine's rules, and the owner reversed it.** It
  shipped required/recommended property profiles taken from that engine's documentation, a
  "deprecated feature" rule for markup the engine had stopped showing, and a listing field and
  filter for those features. Its clause 2 then measured false positives against the same
  engine's testing tool. That run found one disagreement between the engine's documentation and
  its tool on a software-application rating, and the profile was changed to match the tool
  (`df24d2a`). The owner's ruling, 2026-11-16: no single engine is the benchmark, and the
  crawler reports facts; the agent judges. The rework removed the profiles, those three rules,
  the listing field, its filter and the matching CSV problems, and replaced them with
  `schema.empty-value`, `schema.unresolved-reference`, `schema.property-coverage` and the
  listing's `nodes`. Clause 2 was restated to compare against the page source and
  validator.schema.org. The first gate record is in this file's history (`ef83f3e`).
- **Task 10's fixtures caught a Task 5 defect** in the since-removed deprecated-feature rule
  (subtype matching).
- **The first build's final review found two false-positive sources**, fixed in
  `7cf3120`/`a962f6c`: ProductGroup matched the product profiles (both since removed), and an
  RDFa `property` with no enclosing `typeof` counted as a parse error (it is now an
  unsupported skip).
- **The 50k re-run found the derivation's ordering defect** (§3).
- **This gate found the multi-type defect** (§2.4).
- **The rework's reviews found** that ids must be resolved against the document base before
  comparison (JSON-LD 1.1); that a typed node with no properties is empty (the spec's own
  definition); that orphan `structured_data` rows, which the page writer leaves on purpose when
  a page insert loses a race, must be skipped and counted, not refused; and that capped problem
  lists must say so (`problemsCapped`).
- **The plan named `gate-crawl.ts` for clause 3**; the bound belongs to `gate-rules.ts` (§3).

## 6. Rulings

**Rework (from the rework ledger, binding):**
- R1–R3 were built as one task, since removing the blob fields breaks compilation across
  validator, rules and API.
- `@id` values, defined and referenced, are resolved against the page URL or a declared `@base`
  (JSON-LD 1.1); blank nodes stay as written; a `@context: null` resets the base.
- An object with no properties and no `@id` is empty; keywords such as `@type` are not
  properties, and a blank `@id` is no `@id`.
- On a crawl not wholly at extraction 4, unresolved references are not counted, and the
  listing's `notMeasured` says so; a plain CSV download has no channel for it.
- A page at the 50-block cap still gets its unresolved-reference finding, with
  `blocksAtCap: true`; counting the dropped blocks needs extraction 5.
- Orphan `structured_data` rows are skipped by the derivation and counted as
  `deriveSchemaValidation.orphanBlocks`; every reader already joins `pages`.
- Multi-type nodes list every stated type; extraction stays frozen, so microdata and RDFa keep
  their first type at extraction 4.
- property-coverage counts the judged pages, as `content.metrics-by-type` does, and only nodes
  of schema.org blocks (`otherVocabularyNodes` counts the rest).
- Clause 2 compares against the page source and validator.schema.org; a validator refusal is
  recorded, never worked around.

**First build (still binding where the code survives):** R0.1 (pending/superseded properties are
their own info rule), R0.2 (untyped nested items are nodes), R0.5–R0.9 (vocabulary, the
normalised `schema_type`, site rules gated on v4, `warningCount`/`infoCount`, microdata text
scope), and the Task 1–3, 8, 9 and 11 execution rulings recorded in `ef83f3e`. R0.3's and
R0.4's search-engine parts are void.

## 7. Open items

- **greenpeople.co.uk (Shopify) re-crawl.** It needs the store's Shopify crawler signature. In
  admin: Online Store → Preferences → Crawler access → Create signature; one signature per
  domain, valid up to 90 days. The `Signature-Input`, `Signature` and
  `Signature-Agent: "https://shopify.com"` headers go in as the crawl's
  `credentials.requestHeaders` (27c, encrypted at rest, sent only to the site family), or the
  store adds a CDN skip rule for AriadneBot. It would give live evidence on product markup,
  which simpleerb.com does not carry.
- **validator.schema.org on the last three sample pages**, when its rate limit allows.
- **Extraction 5:** microdata `itemtype` and RDFa `typeof` keep every token; count blocks
  dropped past the 50-block page cap and nodes dropped past the JSON-LD depth cap.
- **A capped references list** (more than 50 bare references in one block) can hide a later
  unresolved reference; the listing shows `problemsCapped`. Lifting that cap is a follow-up.
- **User-agent presets (owner request, backlog).** A preset needs its robots.txt token as its
  own config. Today `userAgent` feeds both the header and robots-parser, which keys on the text
  before the first "/", so a browser-style string matches as "mozilla" and falls to the `*`
  group. A spoofed crawler string does not pass a CDN's IP verification.
- **Pagination inside a slug page type.** Page-type inference groups `/blog/10/` with
  `/blog/:slug`, so `schema.template-inconsistent` flags listing pages (§2.5).
- **Leaked test workers.** Two `src/worker/serve.ts` processes started 2026-11-11 by the 28b
  worker tests were still polling the dev database on 2026-11-16; find the test that leaks its
  child.
- **`ariadne_gate29a` is kept until the owner's OK to drop it.**

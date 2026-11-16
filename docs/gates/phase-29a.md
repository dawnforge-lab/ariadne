# Phase 29a gate: structured data

Date: 2026-11-16. Spec: `docs/superpowers/specs/2026-11-12-phase-29-checks-wave-2-design.md`
(§29a, "Gates" 29a, clauses 1 to 4). Plan: `docs/superpowers/plans/2026-11-13-phase-29a-structured-data.md`.
Branch `worktree-phase-29`, built on `c2b6c47` (main) plus the design (`bbe9eb0`) and the plan
(`f7c3eb7`).

Code under test: `df24d2a`. That is Tasks 1–11 (`15853e0`..`777d28f`), the final-review fix wave
(`7cf3120`..`25dcb68`), and two fixes the gate itself called for:

- `63091e5`: the schema-validation derivation orders by the numeric id, not its text alias. The
  50k gate's second run found the defect (§3).
- `df24d2a`: the `software-app` profile treats a rating or review as recommended, as the Rich
  Results Test judges it. The live crawl found this (§2).

**Verdict: all four clauses pass.**

- **Clause 1:** every new `schema.*` rule fires on the fixture site exactly the number of times
  the fixtures call for. The clean microdata and RDFa pages fire nothing.
- **Clause 2:** a live crawl of simpleerb.com (owner-named, owner OK) produced one
  `schema.google-required-missing` finding. The Rich Results Test judged it a false positive. The
  profile was fixed with a test and the rules were re-run on the same crawl: **0 findings, so
  0 false positives remain.**
- **Clause 3:** the 50k gate on the final derivation code peaks at **278.7 MB** against the
  local bound of 290.2 MB.
- **Clause 4:** `test/rules/coverage.test.ts` is green.

The full suite on `df24d2a` is 184 files and 4,865 tests, all green, and `npx tsc --noEmit` is
clean.

All gate runs used a database made for them, `ariadne_gate29a`, on the dev container
(`create database ariadne_gate29a`, then `npm run db:migrate`: 55 migrations applied, 55 journal
entries). The gate never connected to the dev database `ariadne`. `ariadne_gate29a` is kept;
dropping it waits for the owner's OK.

## 1. Clause 1: the fixture site

`test/fixtures/pages/authored-p29a.ts` adds 19 pages, every one `exact: true`:

- seven single-rule pages, for parse-error, unknown-type, unknown-property,
  pending-or-superseded, embedded-type-mismatch, deprecated-feature (FAQ) and
  google-required-missing (an Event without `startDate`);
- a clean microdata Product and a clean RDFa Organization;
- a ten-page template (`/authored29a/tpl/1`–`10`) whose tenth page drops the Product that the
  other nine carry, so `schema.template-inconsistent` fires once.

`test/fixtures/harness.test.ts`, "each schema.* rule wrote exactly the findings the fixtures call
for (Gate 29a clause 1)", pins the crawl-wide count per rule with `toEqual`. An extra rule or a
missing key fails the test.

| rule | findings | from |
|---|---|---|
| `schema.parse-error` | 1 | `/authored29a/` single-rule page |
| `schema.unknown-type` | 1 | the same |
| `schema.unknown-property` | 1 | the same |
| `schema.property-pending-or-superseded` | 1 | the same |
| `schema.embedded-type-mismatch` | 1 | a Book whose `author` is an Offer |
| `schema.deprecated-feature` | 1 | the FAQPage page |
| `schema.google-required-missing` | 2 | `/authored29a/event-no-date` (startDate), `/authored3/product-incomplete` (image) |
| `schema.google-recommended-missing` | 2 | `/authored3/product-incomplete`, `/authored3/reviews` |
| `schema.template-inconsistent` | 1 | `/authored29a/tpl/10` |
| `schema.self-serving-reviews` | 1 | `/authored3/reviews` |
| `schema.breadcrumb-absent` | 1 | site-scoped: the fixture carries no BreadcrumbList |
| `schema.none-on-site` | 0 | the site carries markup |

`SKIP_HARNESS_CLAIMS` is back to 26 entries (Task 7 raised it to 32 while the fixtures were
missing).

## 2. Clause 2: the live crawl

### 2.1 Which site

The owner first named greenpeople.co.uk, a Shopify store (2026-11-16). Cloudflare blocked both
attempts at the first request:

- `crawl_b282e851-…`, AriadneBot UA: the homepage returned 403 and was recorded as a classified
  `blocked (403) after 3 attempts, spacing reached 1000ms` row; `/sitemap.xml` returned 403.
  robots.txt was read.
- `crawl_f9f5af9a-…`, run at the owner's direction with the UA `Googlebot/2.1
  (+http://www.google.com/bot.html)`: the same result.
- One diagnostic request returned 403 with a 5,529-byte body titled `Just a moment...`. That is
  a managed JavaScript challenge, which no non-browser client passes, and Cloudflare verifies
  Googlebot by IP. The challenge was not solved or bypassed.

The owner then named **simpleerb.com**, a non-e-commerce software site, with the direction that
"the crawler should not be tailored for eccomerce only". greenpeople.co.uk, with a Shopify
crawler signature, is an open follow-up (§7).

### 2.2 The crawl

`crawl_8b55e8e6-9802-4417-ad80-720352d9b13b`, head `63091e5`. The settings were AriadneBot UA,
`maxPages` 1,000, the default politeness (robots.txt, crawl-delay, 1 s per host) and
`fetchResources: false`. The script is
`.superpowers/sdd/2026-11-13-phase-29a-structured-data/crawl-greenpeople.mts`, which takes
`GATE_SITE` and refuses any database other than `ariadne_gate29a`.

- 753 pages, 0 failed, 274 sitemap entries; crawl 760 s, rules 21 s.
- 416 structured-data blocks, all JSON-LD:

  | type | blocks |
  |---|---|
  | BlogPosting | 199 |
  | BreadcrumbList | 107 |
  | FAQPage | 44 |
  | Organization | 42 |
  | HowTo | 19 |
  | SoftwareApplication | 2 |
  | Corporation | 2 |
  | TechArticle | 1 |

- `schema.*` findings:

  | rule | findings |
  |---|---|
  | `schema.deprecated-feature` | 50 |
  | `schema.google-recommended-missing` | 200 (truncated from 226) |
  | `schema.google-required-missing` | 1 |
  | `schema.parse-error` | 24 |
  | `schema.template-inconsistent` | 16 |

### 2.3 Every google-required-missing finding, against the Rich Results Test

| URL | feature | engine's missing list | Rich Results Test (2026-11-16, 09:36) | verdict |
|---|---|---|---|---|
| https://www.simpleerb.com/pricing/ | software-app | `aggregateRating \| review` | "Software apps: 2 valid items". The item without a rating: "1 non-critical issue — Missing field 'aggregateRating' (optional)" | **false positive** |

The page carries two SoftwareApplication blocks. The one with an AggregateRating was judged
clean by both the engine and the test. The other has `name`, three Offers with prices,
`applicationCategory` and `operatingSystem`, and no rating or review.

**Google's docs and its test disagree.** The docs page
(developers.google.com/search/docs/appearance/structured-data/software-app, read 2026-11-16)
still lists "aggregateRating or review" as required: "You must include one of the following
properties". The Rich Results Test calls the field optional and the item eligible. Clause 2's
authority is the test, so `df24d2a` moves the pair to the profile's recommended list, with a
test (`test/rules/schema-validate.test.ts`). The cost, if Google later enforces the docs, is
under-reporting, which the 0-false-positive bar prefers.

**Re-run.** The rules were re-run on the same crawl at `df24d2a` (database only, no fetch).
`schema.google-required-missing` now has **0 findings**, and the total fell from 3,554 to 3,553.
The pricing page's missing rating is now a recommended-missing problem. That rule lists the
first 200 of 226 pages by URL and records the truncation, so the pricing page is counted but not
listed.

### 2.4 The other schema findings, checked (not gated)

- **`schema.google-recommended-missing`, 200 shown of 226.** The groups are:
  - article/BlogPosting `[author.url, image]` 183;
  - BlogPosting `[author.url]` 14;
  - Organization 2, Corporation 2;
  - TechArticle `/api/` 1, which has no author, dates or image.

  A sample shows `"image": ""` (an empty string) and authors with only a `name`. All true.
- **`schema.parse-error`, 24.** All are `/blog/tag/*` pages. Each carries three
  `<meta itemprop="name|image|description">` with no enclosing `itemscope`, legacy
  snippet tags. That is invalid microdata per HTML, which the W3C validator reports, and Google
  ignores it. The counts are true.
- **`schema.template-inconsistent`, 16.** These are blog pagination pages (`/blog/10/`…) that
  page-type inference groups with the 199 posts as `/blog/:slug` (199 of 215 pages carry
  BlogPosting). They are true to the data but misleading to a reader. This is an open item (§7).
- **`schema.deprecated-feature`, 50 pages.** These carry FAQPage (44 blocks) and HowTo
  (19 blocks). FAQ rich results have not been shown since 2026-05-07; Google's changelog was re-read
  2026-11-14, and the FAQPage documentation was removed in June 2026.

## 3. Clause 3: the 50k gate

`scripts/gate-rules.ts` runs crawl, render and rules over the 50,000-page fixture in one
process. That is the measure behind the 290.2 MB local bound (27d, 28c). The plan named
`scripts/gate-crawl.ts`, which crawls only; it ran once and passed at 207.0 MB.

| run | head | crawl | peak (crawl / render / rules) | rules wall | result |
|---|---|---|---|---|---|
| 1 | `777d28f` | `crawl_dbb15457-…` | 281.8 / 283.3 / 284.2 MB | 406.5 s (derivations 46.6 s) | GATE PASSED |
| 2 | `25dcb68` | `crawl_5afec783-…` | 290.2 / 290.2 / — | — | **threw** (below) |
| 3 | `63091e5` | `crawl_e710f626-…` | **278.7** / 226.4 / 271.3 MB | 417.3 s (derivations 32.7 s) | **GATE PASSED** |

Runs 1 and 3 each wrote 155,649 findings.

**Run 2 found a real defect.** The rules phase threw:

```
schema.unknown-type: …/products/p0 structured data has no validation — re-run the rules
```

20,001 of the crawl's 40,000 blocks carried a validation blob. The derivation selected
`id::text as id … order by id`. Postgres binds a bare `ORDER BY id` to the text output column,
so rows sorted lexically ("100000" < "80001") while the cursor advanced numerically
(`id > $cursor::bigint`). The crawl's ids ran from 80001 to 120000, so every id below 100000 was
skipped. Run 1's ids, 40001–80000, never crossed a digit boundary.

Any database past 99,999 `structured_data` rows would have refused every rules run. That
refusal was loud, via the rule's no-validation throw, but permanent. `63091e5` orders by the
qualified column and adds an end-of-derivation count check that names the crawl. A regression
test uses 600 ids from 99,999,999,700 to 100,000,000,299: before the fix it failed
(blocks 1,200 against 600 rows); after it, it passes. The CSV view already ordered by `sd.id`.
No other unqualified `order by` on a text alias exists in `src/`.

**Peaks.** The crawl-phase peaks over runs 1–3 were 281.8, 290.2 and 278.7 MB. Run 2's reading
sits at the bound and matches the run-to-run spread seen before (27d: 275.7 and 281.5 MB). The
evidence is run 3, on the final derivation. `deriveSchemaValidation` alone on run 1's crawl took
4.3–5.2 s for 40,000 blocks, about 1% of the rules wall. `df24d2a` changes one profile entry
after run 3 and does not touch memory or the derivation. CI's weekly `gate.yml` series continues
as the runner-side measure.

## 4. Clause 4: coverage

`test/rules/coverage.test.ts` is green in every full-suite run (`9c4d222`, `2c886b7`, `63091e5`,
`df24d2a`). Every new rule claims CHECK-43; the two Google rules also claim CHECK-44.

## 5. What did not go as first written

- **Task 10's fixtures caught a Task 5 defect.** `schema.deprecated-feature` matched HowTo's
  subtypes, so every Recipe fired. It now matches FAQPage and HowTo exactly (`9c4d222`).
- **The final review (Opus) found two false-positive sources**, fixed in `7cf3120`/`a962f6c`:
  - ProductGroup (a Product subtype) matched the product profiles, so Google's own variant
    markup fired `required-missing`;
  - an RDFa `property` with no enclosing `typeof` counted as a parse error.

  The same wave made microdata read `content` on any element (`1c592aa`) and stopped a text
  author in `@value` form from missing `author.name`.
- **The 50k re-run found the derivation's ordering defect** (§3).
- **The live crawl found the software-app profile defect** (§2.3).
- **The plan named `gate-crawl.ts` for clause 3**; the bound belongs to `gate-rules.ts` (§3).

## 6. Rulings

**Planning (binding, from the plan):**
- R0.1: pending and superseded properties are their own info rule,
  `schema.property-pending-or-superseded`.
- R0.2: untyped nested items are nodes.
- R0.3: findings are per page, and Google judges each node.
- R0.4: which nodes the Google features match.
- R0.5: which vocabulary a name is in.
- R0.6: `schema_type` holds the normalised schema.org name.
- R0.7: site rules are gated on v4.
- R0.8: the listing counts are `warningCount`/`infoCount`.
- R0.9: microdata text is read with the same text scope as content.

**Execution (from the ledger):**
- T1: a class reachable from Thing is a type, even if typed DataType, so the Quantity family
  stays types.
- T2:
  - a stray `itemprop`+`itemscope` is both an error and a top-level item;
  - `@`-prefixed itemprop tokens are errors;
  - blocks are emitted at item close;
  - the error counter is shared with RDFa;
  - `ItemMachine.end()` throws on an open frame.
- T3: "RDFa attribute" means vocab, typeof, property and prefix; unsupported is counted per
  element; an empty top-level `typeof` is an error.
- T5 (under-report for the 0-false-positive bar):
  - the profile follows Google's docs page, not the plan text;
  - a non-empty string satisfies `<x>.name`;
  - a nested Review/AggregateRating matches only under Google's reviewable parents;
  - a top-level rating carrying `@id` waives the nested requirements;
  - `@context` propagates onto `@graph` members;
  - a breadcrumb item needs a name, a record or an `@id` reference, never a string.
- T7: `/authored3/reviews` also fires recommended-missing, which is correct; each rule parses
  only the rows it selects.
- T8: the none-on-site copy is updated, since v4 reads microdata and RDFa.
- T9: an unjudged or pre-29a listing is CONFLICT (409); on pages below v4, `microdataErrors` is
  null and counts as 0 in `warningCount`, as the tool says.
- T10:
  - deprecated-feature matches exactly;
  - the type-mismatch fixture uses a Book.
- T11:
  - MCP INSTRUCTIONS step 5 is not extended, since the list is curated;
  - the CHECK-46 Organization-branch sentence is kept;
  - clause 3 runs `gate-rules.ts`.
- Final review:
  - fixed: I1, I2, M1, M3, M4, M5, M7, M8, the `@value` author, the per-rule count pins,
    breadcrumb copy;
  - left: M2 (RDFa `href` as id), M6, the derive Quantity guard, microdata CPU on hostile pages
    (bounded by caps), the T4 commit trailer, the unreproduced batches flake, the pre-29a index,
    lax jsonpath, `@context` layering.
- Gate:
  - the derivation ordering fix;
  - the Rich Results Test, not the docs page, is clause 2's authority for software-app.

## 7. Open items

- **greenpeople.co.uk (Shopify) re-crawl.** It needs the store's Shopify crawler signature. In
  admin: Online Store → Preferences → Crawler access → Create signature; one signature per
  domain, valid up to 90 days. The `Signature-Input`, `Signature` and
  `Signature-Agent: "https://shopify.com"` headers go in as the crawl's
  `credentials.requestHeaders` (27c, encrypted at rest, sent only to the site family), or the
  store adds a Cloudflare skip rule for AriadneBot. This would give live evidence on the product
  profiles (ProductGroup, merchant-listing), which simpleerb.com does not exercise.
- **User-agent presets (owner request, backlog).** A preset needs its robots.txt token as its
  own config. Today `userAgent` feeds both the header and robots-parser. robots-parser keys on
  the text before the first "/", so a browser-style string (`Mozilla/5.0 (compatible;
  Googlebot/2.1…)`) matches as "mozilla" and silently falls to the `*` group. A spoofed Googlebot
  does not pass Cloudflare's IP verification.
- **Pagination inside a slug page type.** Page-type inference groups `/blog/10/` with
  `/blog/:slug`, so `schema.template-inconsistent` flags listing pages (§2.4).
- **Untested residuals from the re-review:**
  - no test pins a node typed `["Product","ProductGroup"]` (it is excluded, consistently);
  - microdata `content` on `a`/`link`/`img` is stored unresolved, like `meta`.
- **The Google docs/test disagreement on software-app ratings.** Re-check when Google next
  updates the page (`GOOGLE_DOCS_READ`).
- **The unreproduced "batches" test flake** may be the ordering defect: the 1,201-row test
  straddling a power of ten of the dev sequence. It has not recurred.
- **`ariadne_gate29a` is kept until the owner's OK to drop it.**

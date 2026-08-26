# Phase 3 gate — the query rules, every one of them proved on one crawl

**Date:** 2026-08-26
**Code:** branch `worktree-phase-3-query-rules` at `456d610` (the last fixture
commit), plus the commit that adds this file, the strengthened coverage
assertion and a one-line spec correction. **The suite, harness, fixture,
ruleset and coverage figures below were measured on exactly that tree** — the
added files are a test assertion and two documents, so they change no behaviour
those figures describe. The three duplicate-detection timings under "what Phase
4 inherits" are the one exception, and carry their provenance there: they come
from Task 7 and were not re-measured at gate time.
**Verdict:** PASSED, under the owner-approved gate amendment recorded below.
**36 new rules** join the 28 Phase 2 left, all of them `query`-kind; the coverage
pin falls from **29 unclaimed to 7**, and those seven are exactly the checks no
crawl-derived rule can honestly answer yet. **57 of the 64 registered rules fire
on one crawl of the fixture site**, and the other seven are argued, listed and
asserted-not-to-fire rather than quietly excused. The full suite is **775 tests
across 42 files, green**, with `tsc --noEmit` clean.

## The gate amendment — why 7, not 0

The build plan's Phase 3 gate reads: *"every one of the 47 crawl-derived
`CHECK-NN` ids is claimed by a rule or explicitly marked `AGENT` in the
registry."* That is unsatisfiable in Phase 3 without writing rules that always
pass, which hard rule 1 forbids. Two causes, both structural:

| checks | why no rule can speak yet | phase that can |
|---|---|---|
| CHECK-01, CHECK-02, CHECK-34 (`RENDER_CHECKS`) | they are questions about what the page shows **after its JavaScript has run**. The crawler stores the raw body; a rule written against it would report the empty shell as the page — worse than reporting nothing. | **Phase 5** (render pass) |
| CHECK-08, CHECK-29, CHECK-33, CHECK-33b (`METRIC_PENDING_CHECKS`) | their answer is a site-wide **number** — a distribution, a cohort — not a per-page fault. The `metric` kind is defined and validated; the runner does not drive one yet. | **Phase 4** (metric rules) |

The owner amended the gate on 2026-08-26: Phase 3 claims the 22
query-claimable checks, and the pin shrinks to exactly those seven, each
annotated in the registry with the reason it is still absent. The annotations
are not prose — `RENDER_CHECKS` and `METRIC_PENDING_CHECKS` are exported
constants, and `test/rules/coverage.test.ts` now asserts

```ts
expect([...RENDER_CHECKS, ...METRIC_PENDING_CHECKS].sort()).toEqual([...unclaimed].sort());
```

as **equality in both directions**. An unclaimed check with no annotation fails,
an annotation whose check gained a rule fails, and a duplicate across the two
lists fails on length. The pin and the reason for it cannot drift apart.

## How to reproduce

```bash
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm run db:migrate
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npm test
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne npx tsc --noEmit
```

The gate lives in `test/fixtures/harness.test.ts`, unchanged in kind since
Phase 2: it starts the fixture site on loopback, runs the real `runCrawl`
against it once, runs the real `runRules` once, and asserts from the `issues`
table it wrote. Nothing in it stubs a fetch, hand-builds a `pages` row, or calls
a rule directly.

## The ruleset — 64 rules (`RULESET_VERSION` 0.2.0)

| kind | count | change this phase |
|---|---|---|
| `page` | 26 | unchanged — Phase 2's page rules, with `content.{thin,placeholder}` re-homed to the `content` category |
| `query` | 38 | **+36**: redirect chains and loops, broken internal links, canonical targets, orphans, hreflang joins, pagination, robots, sitemap joins, URL and host hygiene, soft-404, duplicate content, structured data |
| `metric` | 0 | still none — Phase 4 |

The 36 new rules, by family: `redirect.{chain,loop}`, `links.{broken-internal,
orphan,orphan-skipped}`, `canonical.{non-200-target,non-indexable-target}`,
`hreflang.{missing-return-link,non-indexable-target}`,
`pagination.{canonical-to-other,next-not-linked,next-target-uncrawled}`,
`robots.{missing,check-skipped,blocks-sitemap-urls}`,
`sitemap.{missing,invalid,non-200,redirected,non-indexable,uncrawled}`,
`pages.not-in-sitemap`, `url.{normalisation-variants,tracking-params-internal,
parameter-pages-indexable}`, `host.{http-serves-200,duplicate-host-200,
legacy-host-reachable,probe-skipped}`, `content.{soft-404,exact-duplicate,
near-duplicate}`, `schema.{none-on-site,breadcrumb-absent,product-incomplete,
self-serving-reviews}`. The two Phase 2 hreflang rules stay where they were.

`category` is now the closed `RuleCategory` union rather than a free string —
13 members, `defineRule` still rejects a rule missing any client-facing copy at
`buildRegistry()` time, before a crawl.

### Crawl-layer evidence this phase added

The query rules read tables and blobs the crawler did not previously write, all
of them landed in migrations `0003`–`0005`:

- `crawls.discovery_jsonb` — which sitemaps robots.txt declared, and what
  happened to each. `sitemapSources` is **robots-declared documents only**: no
  speculative `/sitemap.xml` probe, by design, which is why `sitemap.missing`'s
  copy says "not declared in robots.txt" rather than "no sitemap exists".
- `crawls.host_probe_jsonb` — the four host spellings (`http`/`https` ×
  apex/`www`) plus any configured legacy hosts, each followed by the real
  fetcher through the politeness gate.
- `crawls.notfound_probe_jsonb` — a crawl-end request for a URL that cannot
  exist, with the simhash of its body when the site answers 200. That value is
  the soft-404 site signature.
- `pages.has_soft404_phrases` — the analyzer's phrase flag, the second of
  `content.soft-404`'s two signal paths.
- `issues.ruleset_version`, stamped per finding, and a `pages (crawl_id, id)`
  index for the cursor scans the query rules page through (`0003`).
- Four expression indexes on the simhash bands (`0004`) and one on
  `structured_data (crawl_id, page_id)` (`0005`).

## The fixture site — 70 pages, two sitemaps, two host names

| source | count | what they are |
|---|---|---|
| absorbed | 42 | pages from the badseo corpus (`test/fixtures/pages/absorbed.ts`). `expectedIssues` is a **floor**, save the last rung of the deep click-chain, which is pinned exact. |
| authored (Phase 2) | 10 | `test/fixtures/pages/authored.ts` — the control recipe with exactly one signal broken, `exact: true`. |
| authored (Phase 3) | 17 | `test/fixtures/pages/authored-p3.ts` — the clusters the query rules needed: canonical targets, a soft-404, a pagination trio, five hreflang pages, a case-variant pair, a tracked URL, an unlisted page, a Product block missing `image`, an Organization with a self-serving rating. All `exact: true`. |
| control | 1 | `/control` — a clean page that must fire nothing. |

Beyond the pages, the site now serves what the join rules need to have anything
to read: a `robots.txt` that allows all but `/private/` and declares **two**
`Sitemap:` lines, a real `/sitemap.xml` listing the hub and 54 of the 70
fixtures. Sixteen are held back by `inSitemap: false`, for two reasons: the
deep click-chain's seven rungs, because a sitemap entry is enqueued at depth 0
and would flatten the chain `structure.deep-page` needs; and nine more, eight of
which a well-made sitemap would not list anyway — the noindexed, blocked,
500-ing and redirecting fixtures, which listed would each collect a second,
off-topic `sitemap.non-indexable` / `sitemap.non-200` / `sitemap.redirected`
finding on top of the one they exist to demonstrate — the ninth being
`/authored3/unlisted`, whose whole subject is being the page the file forgot.

Beside that document the site serves a deliberately broken second one
(`/sitemap-broken.xml`, a 200 that is an HTML error page), lists a
robots-disallowed URL in the good one, and answers to a **second host name**,
passed to the crawl as `legacyHosts` so
`host.legacy-host-reachable` fires from the real probe rather than from
hand-built evidence.

## The harness assertions — 13, all passing

`test/fixtures/harness.test.ts`, 13 tests, 2.67s including the crawl. Phase 2
carried five; Phase 3's fixtures made eight more possible.

| # | Assertion | Result |
|---|---|---|
| 1 | The crawl finishes with 0 pending and 0 failed, and **every fixture path has a `pages` row** — asserted from the rows, not from the findings. | PASS |
| 2 | **Every fixture's expected issues fire on its path** — exact-set equality for all 27 authored fixtures and the deep chain's last rung (28 in all), containment for the rest of the absorbed floor. | PASS |
| 3 | **No rule fires on the control page** — the control is first proved auditable (`fetch_class = ok`, 200, non-null `word_count`), because "fired nothing" on a page nobody analyzed proves the opposite of what it claims. | PASS |
| 4 | **The site-scoped findings are exactly six rule ids** — `host.http-serves-200` (twice: two names, both plaintext), `host.legacy-host-reachable`, `robots.blocks-sitemap-urls` and `sitemap.uncrawled` (same URL, two fixes), `sitemap.invalid`, `schema.breadcrumb-absent` — each pinned by its evidence, and no fixture path blamed for any of them. | PASS |
| 5 | **The sitemap's deliberate mistakes land on the URLs that carry them** — `sitemap.non-200` on the 404, `sitemap.redirected` on the chain head, `sitemap.non-indexable` on the noindexed page, and `pages.not-in-sitemap` as the **exact set** of the eight indexable pages the file omits. | PASS |
| 6 | **The paginated trio proves all three pagination rules**, page 1 silent as the control. | PASS |
| 7 | **The orphans are exactly the two pages nothing links to** — including the one that renders a link to *itself*, which an anti-join counting self-links would have called reachable. | PASS |
| 8 | **The hreflang declarations reach the rules that judge them** — the whole `hreflang` table pinned per path, the x-default finding pinned to the cluster, and the two join rules read as **whole sets** from `issues` (they write one finding per cluster member, so the per-path map keeps only the last). | PASS |
| 9 | **The soft 404 fires on wording alone**, and the *reason* the other signal path is unavailable is asserted from the stored probe (`statusCode: 404, simhash: null`) rather than inferred — "no template" and "a template that did not match" are different crawls with the same silence. Thresholds read from the rules, not restated. | PASS |
| 10 | **The URL-hygiene fixtures name the right URLs** — the case-variant group, and the tracked URL from both sides (the *link* that carries the tag and the *page* that declares it canonical). | PASS |
| 11 | **The structured-data fixtures name the field that is missing and the rating that is self-serving** — field names pinned, because they are what a client goes and adds. | PASS |
| 12 | **The duplicate rules see the site's real duplicates end to end** — the exact-duplicate group, and the near-duplicate pairs pinned *with their Hamming distances* as a whole set. This is the only test that proves the unsigned 64-bit simhash the analyzer computes survives the signed-bigint column and comes back out of the band SQL as the same number. | PASS |
| 13 | **Every registered rule fires on at least one fixture** — strict, over 57 of the 64 rules, with the seven exemptions below each carrying a paragraph and each **asserted not to fire** (an id claimed unfireable that then fires must leave the list). | PASS |

### The seven harness exemptions

`SKIP_HARNESS_CLAIMS`, each covered directly by a DB test that builds the
crawl state it needs:

| rule | why no page of a healthy site can provoke it |
|---|---|
| `links.orphan-skipped` | fires only when the crawl did *not* finish; assertion 1 asserts the opposite. |
| `robots.missing` | needs a site that answers 4xx for `/robots.txt`; this one serves the file every other assertion depends on. |
| `robots.check-skipped` | needs a robots.txt past the 500KB cap or one never served — a property of an unhealthy crawl. |
| `host.probe-skipped` | needs `probeHosts: false`, which would remove the evidence three other host rules read. |
| `host.duplicate-host-200` | needs both `www` and apex spellings answering 200 **over https**; the site is an IP literal on plain HTTP — an IP has no `www.` twin. |
| `sitemap.missing` | fired on every crawl of this site until the fixture sitemaps existed. A site with a sitemap cannot also be one without; the trade buys five claimed join rules for one exemption. |
| `schema.none-on-site` | same trade in the structured-data family: two fixtures had to publish JSON-LD for two rules to be claimed at all. Its sibling `schema.breadcrumb-absent` survives and is asserted firing. |

## Coverage — the pin, not a promise

| | count | ids |
|---|---|---|
| Crawl-derived universe (`CRAWL_CHECK_IDS`) | 47 | checklist Pre-Crawl + sections 1–11 |
| Claimed by a Phase 2 rule | 15 | 04, 05, 12, 13, 16, 17, 18, 20, 21, 25, 31, 35, 36, 37, 40 |
| **Newly claimed this phase** | **+22** | 03, 06, 07, 09, 10, 11, 14, 15, 19, 22, 23, 24, 26, 27, 28, 30, 32, 39, 43, 44, 45, 46 |
| **Claimed total** | **37** | the two rows above |
| `AGENT_CHECKS` — judgement, never a rule | 3 | 38, 41, 42 |
| **Unclaimed — annotated, not forgotten** | **7** | 01, 02, 34 (render → P5); 08, 29, 33, 33b (metric → P4) |

`37 + 3 + 7 = 47`, asserted as arithmetic in the same test so a drift in the
universe itself fails rather than silently changing what "unclaimed" means. No
rule claims an AGENT check. Two Phase 2 claims were *re-claimed* by new rules
rather than added — CHECK-13 by `content.soft-404` and CHECK-25 by the per-set
x-default upgrade — so the +22 counts only genuinely new ids.

**Three claims still sit outside the 47 by design:** `mobile.viewport-missing`
(CHECK-52), `images.{missing-dimensions,missing-alt}` (CHECK-49) and
`performance.slow-response` (CHECK-50) trace to checklist section 12
(Performance & CWV). `unclaimedChecks` only ever *subtracts* from
`CRAWL_CHECK_IDS`, so they neither appear in the pin nor shrink it.

### One claim is narrower than its checklist entry

**CHECK-44 (Product markup) is claimed by a deliberately narrower profile than
the checklist enumerates.** `schema.product-incomplete` judges a Product block
against required `name`, `image`, `offers` (with `offers` needing a `price` or
`priceSpecification`) plus five recommended fields (`description`, `sku`,
`brand`, `aggregateRating`, `review`) — `SCHEMA_PROFILES` in
`src/rules/derive/field-presence.ts`.

The checklist's own CHECK-44 asks for more: `name`, `description`, `image`,
`url`, `sku`, `brand` and an `offers` block carrying `price`, `priceCurrency`,
`availability` and `url`, plus product identifiers (`gtin`/`mpn`) among its
recommended set. The narrower profile was a deliberate choice when the rule was
written, not a field list that got truncated by accident, and the delta is
recorded here so nobody reads the coverage table as more than it says. Widening
`SCHEMA_PROFILES` is additive — the derivation and the rule both read the
profile — so a client catalogue that needs the fuller list is a one-place
change, not a rewrite. Until then, "CHECK-44: claimed" means *this profile*,
and the rest of the checklist entry is the agent's to judge.

## Carried forward — what Phase 4 inherits

1. **The seven pinned checks.** Four are Phase 4's (`metric` kind, the runner
   does not drive one yet); three are Phase 5's. The pin is the work list, and
   the equality assertion means neither phase can close without emptying its
   share.
2. **The crawl-layer normalization seam — two ledgered instances, one fix.**
   The crawler stores some URLs *as published* and others *as normalized*, and
   the query rules join the two spellings exactly:
   - `pages.redirect_url` is the resolved `Location`, not normalized. A
     `Location` carrying a fragment or unsorted query params will not join the
     redirect walk — a false negative in `redirect.chain`/`redirect.loop`.
   - `sitemap_urls.url` is the published `<loc>`; `pages.url` is
     `normalizeUrl` output. The same mismatch gives false `sitemap.uncrawled`
     and false `pages.not-in-sitemap`, mitigated today by a
     `normalizationSensitive` flag on the evidence rather than fixed.

   Both are the same shape and both want the same crawl-layer fix — normalize
   what is stored, or normalize on the join — carried to the Phase 3 final
   review and out of it into Phase 4's backlog. Neither is a rule defect.
3. **A perf caveat the Phase 4 50k expectations must budget for.** *Provenance:
   these three figures were measured during **Task 7** on a synthetic
   5,000-page corpus, not on the fixture site and **not re-measured at gate
   time**. They are the one set of numbers on this page that the tree above
   does not vouch for.* The near-duplicate banding join measured **2.9s over 5k
   pages** before indexing; the four band expression indexes in migration
   `0004` took that same healthy-site 5k corpus to **0.11s** (26×). The worst
   case is not the healthy case: with a **skewed band distribution** the same
   query measured **521ms**, and the join is quadratic *within* a band. At 50k
   pages that is the number to watch, not the 0.11s. **Re-measure at the Phase
   4 gate** before assuming the 50k crawl's rule pass is free.
4. **A hard kill still loses buffered rows** (carried unchanged from Phase 1).

## CI

`.github/workflows/ci.yml` is unchanged: `ubuntu-latest`, a health-checked
`postgres:16` service, Node 22, then `npm ci` → `npx tsc --noEmit` →
`npm run db:migrate` → `npm test`. Its triggers are **push to `main` and every
pull request**, so this branch's first CI run is **pending the first pull
request** — there is no run to link yet, and the figures above are from the
local run recorded below. The Phase 2 gate's lesson applies: record the run
link once it exists rather than claiming a green CI that has not executed.

## Machine

| | |
|---|---|
| Node | v22.23.2 |
| Postgres | 16, Docker container `ariadne-pg` on port 5440 |
| Suite | 775 tests, 42 files, 19.7s wall |
| `tsc --noEmit` | clean |

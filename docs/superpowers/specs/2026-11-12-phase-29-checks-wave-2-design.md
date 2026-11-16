# Phase 29 — Checks wave 2

Date: 2026-11-12. Predecessor gate: Phase 28c (`docs/gates/phase-28c.md`, merged in PR #31,
`c2b6c47`).

Status: design, awaiting owner review. A fresh builder read it once against the code and raised
eight points, all answered in place:
- `render.h1-changed` already exists, so it is dropped here.
- Third-party request failures cannot be seen, so that rule is dropped.
- The image stand-ins also cover CDN images and `srcset` widths.
- An image server that ignores Range still has its whole body counted.
- Images are gated on the fixture site.
- Severities use the registry's three levels.
- The render stamp is per page.
- The diff joins on the unique URL, with its thresholds as request parameters.

Owner direction (2026-11-12):
- "Let's start 29".
- Integrations move to the end of the roadmap: "the main tool Parallax or Talos will provide
  these integrations so we will see at the end how we connect them".
- "Mobile renderer can be skipped, main tool provides a rendering service that agent can call
  to sample".
- External link checking is dropped: "the goal is website health … in the whole context of
  crawl and audit. External links don't matter in this context or have very little value. One
  thing that we can probably count is the number of external links from a page".
- Then "Let's skip the questions".

The scope comes from the roadmap's checks wave 2, trimmed by the owner as above. Where neither
the roadmap nor the owner settles a point, the call is mine. Those calls are listed at the end
for the owner to check.

## Intent

Check coverage is still the largest product gap (roadmap, Intent). Wave 1 (Phase 26) closed the
parser and SQL families. Wave 2 closes the families that need a validator, the render pass or a
whole-crawl computation. It also turns some data Ariadne already collects but never reports
into findings.

**Collected but never reported.**
- The render pass stores every rendered page's console errors, uncaught exceptions and failed
  requests in `pages.render_console` (migration 0025). No rule, metric or API reads it, and
  CHECK-51 in the checklist still says JS errors are "NOT MEASURED".
- `pages.structured_data_parse_errors` counts JSON-LD blocks that do not parse. No rule reports
  it.

**Done shallowly.**
- Structured data is JSON-LD only. It is checked against a few hand-written field profiles,
  with no vocabulary and no Google rich-result requirements.
- `schema.self-serving-reviews` matches exact `@type` strings, so `Restaurant` is missed where
  `LocalBusiness` is caught. This is a documented gap.
- `crawl_compare` compares findings rule by rule. It cannot say that a page's title, status or
  canonical changed between two crawls. Phase 28c's schedules now produce exactly those crawl
  pairs.

**Not done at all.**
- Accessibility.
- Images served larger than they are displayed.
- Internal link score.
- Anchor text per target page.
- The number of external links a page carries. Today that count appears only in
  `links.high-outlinks` evidence, and only for pages over its limit of 10.

Success looks like this. A crawl of a real client site reports:
- broken and Google-ineligible structured data, in all three formats;
- the JavaScript errors and failing requests of the rendered sample;
- the images it downloads at twice their displayed size;
- a WCAG A/AA accessibility subset;
- a link score, per-page link counts and the anchors each page receives.

A weekly schedule's two crawls can be diffed field by field. All of it holds the memory
contract at 50k pages.

## Goals

The phase splits into three parts, each with its own plan, gate and PR, like 26 and 28:

- **29a — Structured data.** Microdata and RDFa extraction, schema.org vocabulary
  validation, and Google rich-result requirements.
- **29b — Render-pass checks.** JavaScript errors and failed requests, images larger than
  displayed, and the accessibility subset.
- **29c — Crawl analysis.** Per-page link counts, link score, anchor aggregation, and the
  field-level crawl diff.

The parts are independent. They are ordered by what each adds per unit of work, and each lands
on its predecessor's green gate.

### 29a — Structured data

**Extraction (streaming, `page-analyzer.ts`; hard rule 4).**
- **Microdata:** `itemscope`, `itemtype`, `itemprop` and `itemid`. A nested `itemscope` gives
  a nested item.
- **Microdata values** follow the HTML spec:
  - `content` on `meta`;
  - `href` or `src` on `a`, `link`, `img`, `audio`, `video`, `source`, `iframe`, `embed` and
    `track`;
  - `datetime` on `time`;
  - `value` on `data` and `meter`;
  - otherwise the element's text, capped like other stored text.
- **`itemref` is not followed**, because it points at ids anywhere in the document, which a
  single forward pass cannot resolve. It is counted per page (`microdataItemrefSkipped`) so a
  property missing for that reason is visible.
- **RDFa Lite 1.1:** `vocab`, `typeof`, `property`, `resource` and `prefix`. The `schema:`
  prefix and `vocab="https://schema.org/"` (or the http form) are understood.
- **Full RDFa 1.1 is not interpreted** (`rel`/`rev`/`about` chaining, other vocabularies). A
  page using it is counted (`rdfaUnsupported`), not misread.
- **One shape for all formats.** Each item becomes one node in the shape JSON-LD nodes already
  have: `@type`, properties and nested nodes. Rules therefore read every format the same way.
- **The node cap is shared.** `MAX_STRUCTURED_DATA_BLOCKS` and the nesting cap count nodes from
  all three formats together.
- **`EXTRACTION_VERSION` becomes 4.** On a crawl extracted at version 3 or below, microdata and
  RDFa were never looked at. `extraction.not-recorded` names that, as it does for the v2 and v3
  facts. It is never read as "no microdata".

**Storage.**
- `structured_data` gains `format` (`jsonld` | `microdata` | `rdfa`). Existing rows are
  backfilled to `jsonld` by the migration, which drizzle-kit generates.
- `pages` gains `structured_data_microdata_errors`: an `itemprop` with no item scope, or an
  `itemscope` without a resolvable `itemtype`. `structured_data_parse_errors` stays the JSON-LD
  count.

**The vocabulary.**
- A script derives a compact table from one pinned schema.org release: every type with its
  parents, and every property with its domain types, range types, and pending or superseded
  status.
- The table is committed as a data file under `src/rules/schema-org/`, with a provenance header
  (release, file sha, date, changes) and an entry in `THIRD_PARTY_NOTICES.md`.
- The vocabulary is licensed CC BY-SA 3.0 (see Calls).
- The table is not re-synced automatically. A vocabulary update is a deliberate commit, and it
  bumps the ruleset version.

**Google rich-result profiles.**
- Hand-written from Google Search Central's structured-data documentation: required and
  recommended properties per feature, with the documentation date recorded in the file.
- **Features:**
  - Article
  - BreadcrumbList
  - Product: both the snippet and the merchant-listing variants
  - Review snippet and AggregateRating
  - Organization
  - LocalBusiness
  - Event
  - Recipe
  - VideoObject
  - JobPosting
  - SoftwareApplication
- **FAQPage and HowTo** are flagged as restricted or deprecated, not validated for
  eligibility.
- **Type matching walks the hierarchy.** A `Restaurant` matches LocalBusiness through the
  vocabulary's parents. The same walk closes the `schema.self-serving-reviews` subtype gap.

**Rules.** Validation runs at rules time over `structured_data` rows in batches. A vocabulary
or profile change therefore re-judges old crawls without a recrawl (hard rules 2 and 6). All
rules claim CHECK-43 unless noted; severities are mine.

| Rule | Severity | Fires when |
|---|---|---|
| `schema.parse-error` | warning | a page has a JSON-LD block that does not parse, or a microdata error (the stored counts) |
| `schema.unknown-type` | warning | an `@type` is not in the vocabulary |
| `schema.unknown-property` | warning | a property is not defined for the node's type or any of its parents; a pending property is reported as info, not warning |
| `schema.embedded-type-mismatch` | warning | a nested node's `@type` is not allowed by the property's range (or a subtype of it); literal-versus-text is NOT judged, since schema.org lets text stand in for most ranges |
| `schema.google-required-missing` | warning | a node matches a Google feature and lacks a required property, so it is ineligible for that rich result |
| `schema.google-recommended-missing` | info | as above, for recommended properties |
| `schema.deprecated-feature` | info | FAQPage or HowTo markup, with Google's restriction stated |
| `schema.template-inconsistent` | warning | within one page type (the existing template inference), at least 10 pages and at least 70% of them carry a schema type that the rest do not; the rest are listed |

- `schema.product-incomplete` (CHECK-44) is folded into the Google Product profile and retired.
  `crawl_compare` already reports a rule present on one side only.
- `schema.breadcrumb-absent`, `schema.none-on-site` and `schema.self-serving-reviews` stay.
  The last one now walks the hierarchy.

**Surface.**
- The listing `structured_data` gives one row per page: the formats, types and matched Google
  features, error and warning counts, and the per-page skip counters.
- A CSV view gives one row per node: page, format, type, path, and the problem.

**Checklist.** CHECK-43's text is extended to cover microdata and RDFa, vocabulary validation
and Google eligibility, and CHECK-44's to cover the profile it now reads. Ids are added before
rules claim them (hard rule 10).

#### 29a amendment (2026-11-16, owner): web standards, not one search engine

The owner's words, after the 29a gate: "Stop with Google, is not about one search engine is
about a websites health, crawlability, understanding, indexability, agents. Google is not a
rule". Then: "the benchmark is web standards not google". The crawler reports, and the agent
analyses.

This **supersedes** the "Google rich-result profiles" block above, the three Google rows of the
rules table, the "matched Google features" in the listing, and the Google half of the Checklist
paragraph. Structured data is judged against its own standards only:

- the schema.org vocabulary;
- the JSON-LD, Microdata and RDFa specifications.

Industry conventions such as title length are untouched; this amendment is about structured
data only.

**Removed.** These go, with their tests, copy, triage rows, listing field and filter, CSV
problems and docs:

- the Google feature profiles (`src/rules/schema-org/google-features.ts`);
- `schema.google-required-missing`, `schema.google-recommended-missing` and
  `schema.deprecated-feature`.

The validation blob loses `googleFeatures` and `deprecatedFeatures`. No profile decides whether
a fact is reported.

**Kept, unchanged in meaning:**

| Rule | Severity |
|---|---|
| `schema.parse-error` | warning |
| `schema.unknown-type` | warning |
| `schema.unknown-property` | warning |
| `schema.property-pending-or-superseded` | info |
| `schema.embedded-type-mismatch` | warning |
| `schema.template-inconsistent` | warning |
| `schema.none-on-site` | as before |
| `schema.breadcrumb-absent` | as before |

**Changed:**

- **`schema.self-serving-reviews`** is reworded as a fact: an Organization, or any of its
  subtypes, carries a review or rating of itself. The policy wording goes.

**New facts.** Severities are my calls, marked for the owner to check.

| Rule / metric | Severity | Fires when |
|---|---|---|
| `schema.empty-value` | warning | a property's value is empty: `""` or whitespace-only text, `[]` or `{}` (an object with no properties and no `@id`). Empty markup is broken for every consumer. |
| `schema.unresolved-reference` | info | a bare reference (`{"@id": X}` and nothing else) names an id that no node on the same page defines. Linking to an entity defined elsewhere is legal JSON-LD, so this is a fact, not an error. |
| `schema.property-coverage` (metric) | — | per schema type on the crawl: how many top-level nodes carry it, and for each property how many of those nodes carry a non-empty value. This answers CHECK-44 ("Product schema completeness") with facts. The agent judges what is missing for its purpose. |

**Surface.**

- The `structured_data` listing replaces `googleFeatures` and the `feature` filter with each
  page's top-level nodes: `{format, path, type, properties[]}`. The property lists are capped and
  the truncation is noted.
- The CSV view's Problem vocabulary loses the Google problems and gains `empty-value` and
  `unresolved-reference`.

**Gate 29a, clause 2, restated.** The live crawl (simpleerb.com) is re-judged; no re-fetch is
needed, since the rules read the database. Then 20 pages are sampled across its page types.
For each, the items, types and properties Ariadne reports are compared with:

- the page source;
- the schema.org validator, validator.schema.org, which checks the schema.org vocabulary only.

The clause passes at **0 mismatches**. Every `schema.empty-value` and
`schema.unresolved-reference` finding on the crawl is also checked against the source.

Clauses 1, 3 and 4 are re-run on the changed code.

### 29b — Render-pass checks

All of these run only on the rendered set: suspects plus three pages per template, at 5% and at
most 500 pages (`src/crawl/render/select.ts`). Every finding states that it comes from the
sample. Every listing names the template of each sampled page so the agent can generalise with
care. A crawl that was never rendered reports these families as not measured, never as clean
(hard rule 1).

**JavaScript errors and failed requests.** These are read from `pages.render_console`, which is
already stored. They claim CHECK-51, and CHECK-51's text is rewritten to say what is measured.

| Rule | Severity | Fires when |
|---|---|---|
| `render.js-exception` | warning | the page threw an uncaught exception or unhandled rejection |
| `render.console-error` | info | the page logged `console.error` |
| `render.failed-request` | warning | a request the page made itself failed (network error or 4xx/5xx) |

- **Which requests the rule can see.** The renderer's fence fails every cross-origin request
  before it is sent. It also aborts the site's own images, media and fonts as paint-only. So
  `failedRequests` holds only the site's own scripts, CSS, XHR and fetch requests, and
  `render.failed-request` is about those.
- **Third-party failures are not measured.** No rule claims them, and the copy says so: they
  are not measured, rather than absent.
- **Errors our blocking may have caused.** Every `render.js-exception` and
  `render.console-error` finding carries the renderer's own block counts (`blockedByRenderer`).
  An error like `gtag is not defined` may be the fence's doing. The evidence says so, and the
  copy tells the agent to confirm such an error on the live page (the main tool's rendering
  service) before reporting it.
- The renderer's own aborts are never findings.
- `render.h1-changed` already exists (Phase 23, CHECK-01) and is unchanged.

**Images larger than displayed** (CHECK-49). The renderer aborts image requests, and the
resources pass sends HEAD requests. So today nobody knows an image's real dimensions, and a
rendered `<img>` has no real size. The design:

1. **The resources pass reads the image header.**
   - For `kind = image`, the request becomes `GET` with `Range: bytes=0-65535` in place of
     the HEAD. It is one request per distinct image either way, so the request count is
     unchanged (hard rule 9), and it goes through the same gate and host queues.
   - The pass reads the intrinsic width and height from the format header (PNG IHDR, JPEG SOF,
     GIF, WebP VP8/VP8L/VP8X, AVIF `ispe`), then discards the bytes.
   - The total size comes from `Content-Range`.
   - **A server that ignores Range** and answers 200 has its whole body streamed into the
     counter, as the counted GET does today (`bytes_source = 'counted'`). The header is parsed
     from the first 64 KiB of that stream. `images.oversized` therefore keeps every size it
     reports today.
   - **No more requests than before.** Today an image whose HEAD gives no size costs two
     requests (HEAD, then the counted GET). Under this design it costs one. So the request
     count never rises.
   - SVG and unknown formats record no dimensions and say why.
   - Header parsing is not pixel decoding (see Calls).
2. **The renderer uses those dimensions.**
   - For each image request whose URL has stored dimensions, the renderer answers from its
     interception layer with a blank SVG of exactly that intrinsic size, instead of failing
     the request. Layout is then what the real image would produce.
   - **CDN images count too.** This applies to cross-origin image URLs as well (a CDN): the
     resources pass fetched them under their own host queues, and answering from the
     interception layer sends nothing to any host. It is the one exception to "every
     cross-origin request is failed", and it is still no third-party traffic.
   - **`srcset` with width descriptors.** When the browser picks a candidate with a `w`
     descriptor, that descriptor is the candidate's intrinsic width. The stand-in uses it, and
     the height follows the aspect ratio of any candidate with stored dimensions. Width is what
     the rule judges, so responsive images are measured without fetching every candidate.
   - **Otherwise the image is aborted**, as today, and counted as not measured. That covers a
     candidate with no `w` descriptor and no stored dimensions, and a failed fetch.
   - **The measured share is reported** per page, and the gate records it on the fixture site.
3. **The renderer measures each image.** After the page settles, it records each `<img>`:
   `currentSrc`, intrinsic size, and displayed CSS box size. The viewport is the fixed desktop
   1280×900 at device-pixel ratio 1.
   - Images with a zero-size box (hidden), and images never requested (lazy and not reached
     without scrolling), are counted, not measured.
   - The renderer does not scroll.
4. **Storage:** `pages.render_images` (jsonb). It holds the measured, oversized, hidden,
   lazy-unloaded and no-dimensions counts. It also holds the 20 worst images by wasted pixels,
   each with url, intrinsic, displayed and bytes (joined from `resources` when known).
5. **The rule:** `images.larger-than-displayed` (warning) fires when an image's intrinsic width
   is more than **2×** its displayed width (the 2× allows for high-density screens) and the
   displayed width is at least 1 px.
   - The ratio is a judgement threshold, so an agent can override it per crawl (27a).
   - The evidence ranks images by wasted pixels and bytes.

**Accessibility (a chosen subset).**
- **The engine is `axe-core`**, an npm dependency pinned exactly, licence MPL-2.0 (see Calls).
  It is injected into the rendered page after the existing facts are read, and run with
  `runOnly` limited to the subset and `resultTypes: ['violations']`.
- **The subset** (my call): WCAG 2.x A/AA rules that are deterministic, cheap, and overlap
  what a site-health audit already cares about. The plan pins the exact axe ids against the
  pinned version. The list:

  | Group | axe rules |
  |---|---|
  | Text alternatives | `image-alt`, `input-image-alt`, `role-img-alt`, `area-alt`, `object-alt` |
  | Names | `link-name`, `button-name`, `input-button-name`, `select-name`, `label`, `frame-title` |
  | Language | `document-title`, `html-has-lang`, `html-lang-valid`, `valid-lang` |
  | Behaviour | `meta-viewport` (zoom disabled), `meta-refresh` |
  | ARIA | `aria-hidden-focus`, `aria-required-attr`, `aria-valid-attr`, `aria-valid-attr-value`, `duplicate-id-aria` |
  | Structure | `list`, `listitem` |
  | Contrast | `color-contrast` |

- **Storage:** a table `render_a11y` (crawl_id, page_id, axe_rule, impact, node_count, targets).
  `targets` holds at most 5 selectors, each capped at 200 characters. No HTML snippets are
  stored, and the table is tenant-scoped through the crawl.
- **Rules:** one Ariadne rule per axe rule, `a11y.<axe-id>`, generated from one table with
  `defineRule`.
  - Severity: axe impact `critical` or `serious` gives warning; `moderate` or `minor` gives
    info. None is critical; WCAG conformance is the client's call, not an SEO blocker.
  - All claim a new **CHECK-89 "Accessibility — WCAG A/AA subset (rendered sample)"**. It is
    added to the checklist and to the crawl coverage universe.
- **Old crawls report accessibility as not measured.** On a crawl rendered before this phase, a
  new marker `render.not-recorded` names the families never captured: images and
  accessibility. It mirrors `extraction.not-recorded`.
- **Switch:** crawl config `renderAccessibility` (default `true`; config keys are flat) lets an
  agent drop the axe run on a crawl where time matters. A disabled run reports the family as
  not measured, by configuration.

**Stamps.** The existing per-page `RENDER_CAPTURE_VERSION` goes from 2 to 3. It is per page, so
it stays right after a partial re-render. A per-page `pages.render_a11y_ran` tells the states
apart:
- `true`: axe ran; no `render_a11y` rows means no violations.
- `false`: disabled by configuration.
- null: rendered before 29b.

The ruleset version takes the next minor after 29a's.

### 29c — Crawl analysis

**Per-page link counts** (the owner's "number of external links from a page"; CHECK-33).
- `pages` gains three columns:
  - `inlinks_internal`: distinct source pages;
  - `outlinks_internal`: distinct internal targets;
  - `outlinks_external`: distinct external targets.
- They are computed in SQL during the rules run's derive step, next to click depth. So every
  judged crawl has them, old ones included after a rules re-run.
- They appear in page listings, the pages CSV, and `crawl_overview`, which gives p50, p90 and
  max per count.
- `links.high-outlinks` reads the column instead of its own ad hoc count. Its limits do not
  change.

**Link score** (CHECK-33).
- An internal PageRank computed in SQL (hard rule 3): damping 0.85, 20 iterations or
  convergence at 1e-6.
- The graph is internal, followed, deduplicated source→target edges between fetched-OK HTML
  pages.
- A page with no outlinks shares its weight with every page in each iteration.
- It runs in the derive step over an unlogged per-run work table, batched.
- Stored as `pages.link_score_raw` (double) and `pages.link_score` (0–100, log-scaled across
  the crawl, 100 = the crawl's top page).
- A metric `links.score-distribution` reports it by template. No rule judges it: a low score
  is evidence for the agent, not a finding.

**Anchor aggregation** (CHECK-86).
- A listing `anchors_by_target` gives one row per internal target page:
  - inlinks;
  - distinct anchor texts;
  - the top 5 anchors with counts;
  - the share of anchors that are empty or non-descriptive, using the list
    `links.non-descriptive-anchor` already uses.
- A CSV view gives the same.
- One rule, `links.anchors-generic-only` (info): an indexable page with at least 3 internal
  inlinks whose anchors are all empty or non-descriptive. The minimum is a judgement threshold.

**Field-level crawl diff.**
- **Tools:** `crawl_diff` (summary) and `crawl_diff_urls` (paged URLs for one field), plus
  matching routes. They are tenant-scoped, with the same pairing check as `crawl_compare`:
  both crawls belong to the tenant and to one site.
- **The join:** both crawls' pages on `pages.url`, which is unique per crawl (`pages_crawl_url`),
  in one snapshot transaction, in SQL, keyset-paged. Nothing is loaded whole.
  - Not `url_normalised`. It groups case and slash variants and is not unique, so joining on it
    would invent added and removed URLs.
- **Thresholds are request parameters.** The diff thresholds below are parameters of the call,
  with the stated defaults, and are echoed in the answer. Per-crawl judgement overrides are
  stamped by one crawl's rules run, so they cannot govern a comparison of two crawls.
- **Fields:**
  - URL added or removed
  - status code
  - fetch class
  - indexability
  - title
  - meta description
  - H1
  - canonical
  - meta robots
  - word count (change over 20%, a threshold)
  - schema types (set)
  - inlinks (change over 50% and at least 5)
  - click depth
  - link score (change of 10 or more points)
- **Summary output:** changed counts per field.
- **Per-URL output:** before and after values, with text capped as stored.
- **A field with no fact on one side is reported as not comparable**, never as unchanged. That
  covers a newer extraction or a crawl never re-judged.
- **No checklist id:** the diff is evidence for the agent and the report, not a check.

## Non-goals

- **Integrations** (GSC, GA4, Bing, PSI, the credential provider). They move to the end of the
  roadmap, renumbered Phase 30, and will be designed once it is clear how the main tool
  (Parallax or Talos) provides them.
- **A mobile render.** The main tool's rendering service lets an agent sample a page at any
  viewport.
- **External link checking.** Outbound targets stay unrequested. Only their per-page count is
  added (29c).
- **The full axe rule set,** and axe's "incomplete" or "best-practice" results.
- **CSS background images,** and `srcset` candidates the resources pass never fetched (counted,
  not measured).
- **Validating structured data against Google's live Rich Results Test.** The profiles are
  local and dated.
- **Core Web Vitals and Lighthouse** (CHECK-47). That is PSI, which now sits with
  Integrations.
- **Screenshots.** Still undecided (Phase 28 roadmap note); not in this phase.

## Constraints

- **Hard rules 1–10, especially:**
  - every new family has a not-measured state (1 and 7);
  - all link and graph work is SQL (3);
  - the memory contract at 50k (6);
  - licence entries for the vocabulary and axe-core (8);
  - the image header read changes no request count (9);
  - checklist ids come before rules (10).
- **The render budget is unchanged:** 5% of pages, at most 500. The axe run and the image
  measure add time per rendered page, not pages.
- **Migrations** come only through drizzle-kit (0051 onward). Never hand-applied SQL.
- **Secrets:** no new column, log or event carries a credential. A crawl with Basic auth still
  sends it only to the site's own hosts (27c), including the ranged image GET.
- **Tenancy:** every new table, listing and tool is scoped by tenant (28a's sentinel test
  extends over them).

## Surface changes (Talos-facing)

- **New tools and routes:**
  - `structured_data` listing (29a);
  - `anchors_by_target` (29c);
  - `crawl_diff` and `crawl_diff_urls` (29c);
  - new CSV views.
- **New fields:** page listings gain the link counts and the link score, and `crawl_overview`
  gains the link-count distribution.
- **New crawl config key:** `renderAccessibility`.
- `docs/talos-surface.md` and `docs/talos-integration.md` change in the same PRs.
- `skills/ariadne-audit/checklist.md` changes for CHECK-43, 44, 49, 51, 86 and the new 89.

## Gates

Each part's gate is recorded in `docs/gates/phase-29{a,b,c}.md` on a dedicated gate database.

**29a.**
1. The fixture site gains pages that fire every new `schema.*` rule exactly once, plus clean
   pages (valid microdata Product, valid RDFa Organization) that fire nothing.
2. A live crawl of one client site the owner names, with the owner's OK. Every
   `schema.google-required-missing` finding is checked by hand against Google's Rich Results
   Test, with **0 false positives** recorded.
3. The 50k gate stays within its bound (local peak ≤ 290.2 MB; CI per the weekly series).
4. The coverage test is green.

**29b.**
1. The fixture site gains pages with:
   - a thrown exception;
   - a failing same-origin script;
   - an image served at 4× its displayed size;
   - an image at 1×;
   - a `srcset` image with `w` descriptors;
   - a CDN-host image;
   - a lazy image below the fold;
   - one violation per axe rule in the subset.

   Each fires its rule, and the 1× and lazy cases do not. The measured-image share is recorded.
2. The 50k gate with its render pass reports the render pass's duration and the per-page axe
   time (median and p95). Process peak RSS stays within the bound; browser RSS is not gated, as
   today.
   - The 50k gate site keeps serving its images as 404, as it does today on purpose: the
     unmoved `notFound` count is how the gate proves the renderer's aborts never reach the
     server. So images are gated on the fixture site (clause 1 and 3), and the 50k baseline is
     undisturbed.
3. On the fixture site, the resources pass sends **no more requests than before** for the same
   images. That covers a server that honours Range, one that ignores it, and one that answers a
   HEAD with no size.

**29c.**
1. At 50k pages the derive step (link counts and link score) finishes in **≤ 60 s** with no
   peak-RSS growth over the 50k bound.
2. Link score on a small fixture graph matches a hand-computed PageRank to 1e-6.
3. `crawl_diff` over two 50k crawls of the gate site, the second with planted changes (titles,
   statuses, removed URLs), finds exactly the planted changes. Its first page answers in
   **≤ 5 s**, within the memory bound.
4. A schedule-fired pair from 28c diffs end to end.

## Calls I made (owner to check)

1. **Split and order:** 29a structured data, then 29b render-pass checks, then 29c crawl
   analysis. Structured data comes first because it has the most checklist weight and needs no
   new browser work.
2. **Integrations renumbered to Phase 30** (last). The roadmap document is edited in this
   design's commit.
3. **The schema.org vocabulary is committed as derived data** under CC BY-SA 3.0, with
   attribution in `THIRD_PARTY_NOTICES.md`. Share-alike applies to that data file if it is
   distributed. The repository is private today, so this matters only if Ariadne's source is
   ever shipped to others. The alternative is a hand-kept vocabulary of only the types the
   Google profiles use. It has no share-alike, but it gives no unknown-type or
   unknown-property checks.
4. **`axe-core` (MPL-2.0) as an npm dependency,** unmodified. File-level copyleft applies only
   if we modify its files, which we will not.
5. **Image header parsing in the resources pass.** It reads the first 64 KiB of each image to
   find its dimensions. It is not pixel decoding, so I read the earlier "no image decoding"
   decision as untouched, but it is the owner's to confirm.
6. **The renderer stands in a blank SVG of the true size** for each image it would have
   aborted, CDN images included. This keeps zero extra requests to any host and gives a
   faithful layout. It is the fence's one answered-not-failed exception.
   **`srcset` widths come from the `w` descriptors.**
7. **Microdata `itemref` is not followed, and full RDFa is not interpreted.** Both are counted.
8. **Validation runs at rules time, not crawl time,** so a vocabulary update re-judges old
   crawls.
9. **`schema.product-incomplete` is retired** into the Google Product profile.
10. **The accessibility subset** is the list in 29b. Impact maps to warning or info, and no
    accessibility finding is critical. `schema.google-required-missing` is a warning, not
    critical: critical stays for findings like `render.noindex-changed` that remove a page
    from search.
11. **`color-contrast` is in the subset** despite its cost. It is the most common real-world
    failure, and the gate measures its time.
12. **Link score is a column and a metric, not a rule.** Link counts and link score are
    computed in the rules run's derive step, so old crawls gain them on a re-run.
13. **Severities and thresholds:**
    - the 2× image ratio;
    - the 70% template share with at least 10 pages;
    - at least 3 inlinks for generic anchors;
    - the diff deltas: 20% word count, 50% inlinks with at least 5, 10 points of link score.

    The rule thresholds are judgement thresholds an agent can override per crawl. The diff
    deltas are request parameters.

## Open items (not decided here)

- Screenshots of named key pages (from the Phase 28 roadmap note).
- Whether `render.accessibility` should default off on very large render sets, once 29b's gate
  shows the real cost.
- How Integrations connect through Parallax or Talos (Phase 30's design).

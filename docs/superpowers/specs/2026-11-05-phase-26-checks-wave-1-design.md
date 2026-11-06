# Phase 26 — Checks wave 1

Date: 2026-11-05. Roadmap: `docs/superpowers/specs/2026-11-04-roadmap-design.md`.
Predecessor gate: Phase 25 (`docs/gates/phase-25.md`, merged in PR #21).

Status: design, awaiting owner review.

## Intent

Close the audit-relevant check gaps against Screaming Frog that can be answered from what
a single streaming pass, the stored headers and SQL already give us. This is the
roadmap's "checks parity" priority. Owner direction (2026-11-05): write it from the SF
comparison and our gaps, without a question round on the checks.

**Parity means audit parity, not filter parity.** An SF filter earns a rule only when an
auditor would act on it. Some SF filters are facts rather than faults: "contains
canonical", "index/follow", "first page" of a pagination series, "multiple H2". Those
stay facts in the CSV and API views and get no rule. Obsolete directives get no rule
either.

**No HTML store.** Every check here reads a parser fact, a stored header, a stored
string, or SQL over `pages` / `links` / `hreflang` / `resources` / `sitemap_urls`.
Owner direction (2026-11-05): Ariadne does not store raw or rendered HTML at all.
Where rendering matters, it is validated per template through the render pass's
facts, and the agent validates a live page itself when it needs the markup.

## Shape: three sub-phases, each with its own plan and gate

| Sub-phase | What | New data | Ruleset |
|---|---|---|---|
| **26a** | Rules over data we already store | none, no migration | 0.20.0 |
| **26b** | One parser wave and the rules that need it | migration; `EXTRACTION_VERSION` 2 | 0.21.0 |
| **26c** | Multi-source hreflang and sitemap limits | migration; discovery changes | 0.22.0 |

The order is cheapest and safest first. 26a ships value on every existing crawl with no
re-crawl. 26b batches **every** parser addition into one extraction bump, so old crawls
need re-crawling once, not three times. Its rules refuse pre-bump rows through
`extractionCoverage`; that is what Phase 25 built it for. 26c touches discovery and the
memory contract, so it gets its own gate.

Every new rule carries `checkIds`. A new rule maps to an existing check where one
exists. Otherwise it gets a new `CHECK-84+` entry in `skills/ariadne-audit/checklist.md`,
written before the rule (hard rule 10). Every new rule gets issue copy in
`src/rules/registry/copy/issue-copy.ts` in the shipped SEO-tool register.

## 26a — Rules over existing data (no migration)

### Thresholds module (first task)

Every rule threshold moves to one exported module, `src/rules/thresholds.ts`. That
covers the existing `TITLE_MAX`, `URL_MAX`, `THIN_WORDS`, `SLOW_MS`, `DEEP_DEPTH`,
image weight and the rest, plus every threshold added below. The owning files
re-export them, so nothing else changes. This makes Phase 27's per-crawl overrides a
swap of the accessor and nothing more. Values do not change in this task.

### Rules

| Rule id | Fires on | Severity | Checklist |
|---|---|---|---|
| `security.hsts-missing` | 200 HTML page over HTTPS with no `strict-transport-security` | warning | new |
| `security.headers-missing` | HTTPS HTML page missing CSP, `x-content-type-options: nosniff`, or frame protection (`x-frame-options`, or CSP `frame-ancestors`), or with no or unsafe `referrer-policy`. One rule; the evidence names which | info | new |
| `security.http-url` | internal page answering 200 over `http:` (per URL; `host.http-serves-200` stays host-level) | warning | CHECK-14 |
| `security.mixed-content` | HTTPS page referencing an `http:` image, CSS or JS (`page_resources`); 26b widens it to iframes, media and forms | warning | new |
| `resources.bad-content-type` | page or resource whose served content type contradicts what it is (CSS not `text/css`, JS not a JavaScript type, image not `image/*`) | info | new |
| `indexability.nofollow` | page-level `nofollow` or `none` in robots meta or `X-Robots-Tag` | warning | CHECK-04 |
| `directives.restrictive` | `nosnippet`, `max-snippet:0`, `max-image-preview:none`, `noimageindex`. The evidence names which | warning | CHECK-04 |
| `directives.unavailable-after` | `unavailable_after` date in the past or within 30 days | warning | CHECK-04 |
| `canonical.relative` | raw `canonical_html` is relative | info | CHECK-16 |
| `canonical.fragment` | canonical contains `#` | warning | CHECK-16 |
| `canonical.chain` | canonical target itself canonicalises elsewhere (bounded walk; a loop is reported as a loop) | warning | CHECK-17/19 |
| `canonical.unlinked` | canonical target with no internal `<a>` inlink | info | CHECK-17 |
| `hreflang.inconsistent-return-code` | the return link exists but declares a different code | warning | CHECK-24 |
| `hreflang.multiple-entries` | one page lists the same code for two different targets | warning | CHECK-24 |
| `hreflang.self-only` | the page's only hreflang target is itself | info | CHECK-24 |
| `hreflang.unlinked-target` | hreflang target with no internal `<a>` inlink | info | CHECK-24 |
| `pagination.non-indexable-target` | `rel=next/prev` target is non-200 or noindex | warning | CHECK-22/23 |
| `pagination.loop` | a `rel=next` walk revisits a page (bounded) | warning | CHECK-22 |
| `pagination.sequence-error` | A says next is B, but B's prev is not A | info | CHECK-22 |
| `links.internal-nofollow` | page with internal `<a rel=nofollow>` outlinks | warning | CHECK-33 |
| `links.only-from-non-indexable` | indexable page whose every internal inlink comes from non-indexable pages | warning | CHECK-32 |
| `links.localhost` | link to `localhost`, loopback or a private address | warning | new |
| `links.non-descriptive-anchor` | internal anchor text on a fixed generic-phrase list ("click here", "read more", …). English list | info | new |
| `links.high-outlinks` | unique internal or external outlink targets over threshold (calibrated) | info | CHECK-33 |
| `url.uppercase` / `url.underscores` / `url.non-ascii` / `url.spaces` / `url.multiple-slashes` / `url.repetitive-path` | the named defect in an internal page URL's path | info; `spaces`, `multiple-slashes` and `repetitive-path` are warning | CHECK-30 |
| `url.internal-search` | internal search result URL that is indexable (`?s=`, `?q=`, `/search`; list in thresholds) | warning | CHECK-67 |
| `sitemap.over-50k-urls` | sitemap document over 50,000 entries (promoted from the `sitemap.structure` metric column) | warning | CHECK-08 |
| `sitemap.url-too-long` | `<loc>` over 2,048 characters | info | CHECK-07 |
| `sitemap.cross-host-loc` | `<loc>` on a host or scheme other than the sitemap's own | warning | CHECK-07 |
| `sitemap.lastmod-invalid` | `<lastmod>` not W3C datetime, or in the future | info | CHECK-07 |
| `title.pixel-too-long` / `title.pixel-too-short` | title width outside the pixel bounds | warning / info | CHECK-35 |
| `meta-description.pixel-too-long` / `meta-description.pixel-too-short` | description width outside the pixel bounds | warning / info | CHECK-36 |

Pixel rules are **new ids beside** the character rules, so `title.too-long` keeps its
meaning and its history. Width is a pure function of the stored string and a glyph
advance table. **The table is measured by us:** a committed script renders each glyph in
Chromium (we already ship it) in the SERP font and size, and writes a JSON table with a
provenance header saying how it was measured. Nothing is copied from another tool.

### Calibration (part of the 26a gate)

Screaming Frog is installed on this machine. The gate crawls the fixture site with SF
headless at default configuration and compares SF's issues with Ariadne's on the same
pages. The fixture site gets boundary pages for each threshold.

- Every 26a check either matches SF, or its divergence is written into the gate doc
  with the reason. "Ours is template-aware" is a reason; "not looked at" is not.
- Thresholds we do not know SF's default for (high outlinks, pixel bounds, slow
  response, click depth) are set from that run.
- Thin content stays at 150 words unless the run shows a reason to move. Our rule is
  template-aware, and that is a deliberate difference.

The calibration is black-box: SF's output on pages we wrote.

### Gate 26a

Full suite green with 0 skipped, and `tsc` clean. Positive and negative fixture pages
per rule. Calibration report. Rules re-run over the stored lavishalice crawl from the
Phase 25 gate (no re-crawl), with each new rule's finding count reviewed against the
site for false positives.

## 26b — One parser wave (`EXTRACTION_VERSION` 2)

### New facts (one migration, all capped)

- `<html lang>` on the page.
- **Social:** the full OG set (title, description, image, url, type, site_name) and the
  X set (card, title, description, image). Stored in one `pages.social` jsonb holding
  values, per-tag occurrence counts, an outside-head flag, and an `X tag via property=`
  flag. The existing `og_*` columns stay for their consumers. `og:image` and
  `twitter:image` join the resource refs, so the existing resource pass fetches their
  status and size.
- **Headings and head:** first H2 text (capped like `h1_text`); counts of `<title>` and
  `<meta name=description>` elements.
- **Directives:** every robots-class meta (`robots`, `googlebot`, `bingbot`, …) by name,
  replacing first-only; meta refresh (delay and target). `refresh` joins the
  response-header allowlist.
- **Links:** anchor text includes `<img alt>` for image links. Per-page counters for
  empty `href`, `<a>` with no `href`, `javascript:` and `#`-only hrefs, and
  `target=_blank` without `noopener`/`noreferrer`.
- **Insecure references** on HTTPS pages: `http:` iframes, media, and form actions,
  as counts plus a capped sample. Forms on HTTP pages are counted too.
- **Images:** empty-alt count, alt over 100 characters count, and a sample of up to
  10 images missing alt (src only), so a finding names the image.
- **Pagination:** counts of `rel=next` and `rel=prev` elements, not just the first of each.
- **HTML structure:** the element that closes `<head>` early, if any. That is the first
  start tag inside the head that is not head content (`title`, `meta`, `link`, `base`,
  `style`, `script`, `noscript`, `template`), or a non-head element inside a head
  `<noscript>`, for example a tag manager's `<noscript><iframe>`. It is stored as the
  tag name plus a snippet of the tag capped at 200 characters, so the finding names the
  culprit without an HTML store. Also: counts of explicit `<html>`, `<head>` and `<body>`
  start tags, and whether `<head>` comes before `<body>`. This is tracked in the
  streaming tokenizer as state, not a tree. The pre-existing outside-head flags stay as
  they are.

### Rules

| Rule id | Fires on | Severity | Checklist |
|---|---|---|---|
| `social.og-incomplete` | OG title, type, image or url missing (none at all is reported as missing) | info | new |
| `social.og-duplicate` | OG title or description shared across indexable pages | info | new |
| `social.og-multiple` | an OG tag repeated with different values | info | new |
| `social.og-url-mismatch` | `og:url` is not the page's canonical | info | new |
| `social.image-broken` | OG/X image relative or invalid, non-200, or over 5 MB | warning | new |
| `social.x-incomplete` | X card set incomplete, or X tags given via `property=` | info | new |
| `h2.missing` / `h2.duplicate` / `h2.too-long` | as named; too-long is over 70 characters | info | CHECK-37 |
| `title.multiple` / `meta-description.multiple` | more than one element in the document | warning | CHECK-35/36 |
| `title.same-as-h1` | title equals H1 | info | CHECK-35 |
| `directives.bot-conflict` | a bot-specific meta contradicts `robots` (for example `googlebot` noindex under `robots` index) | warning | CHECK-04 |
| `redirect.meta-refresh` | meta refresh or `Refresh` header with a target URL | warning | CHECK-10 |
| `hreflang.html-lang-mismatch` | the self-referencing hreflang language disagrees with `<html lang>` | info | CHECK-25 |
| `links.uncrawlable` | `<a>` that a crawler cannot follow (no `href`, `javascript:`, `#`-only) | warning | CHECK-34 |
| `links.empty-href` | `<a href="">` | info | new |
| `links.no-anchor-text` | internal link with no text and no image alt | info | new |
| `links.unsafe-target-blank` | `target=_blank` without `noopener`/`noreferrer` | info | new |
| `security.form-insecure` | form action over `http:` on an HTTPS page, or a form on an HTTP page | warning | new |
| `images.empty-alt` | images with `alt=""`, counted (decorative images may be legitimate, so info) | info | CHECK-49 |
| `images.alt-too-long` | alt text over 100 characters | info | CHECK-49 |
| `pagination.multiple` | more than one `rel=next` or `rel=prev` | info | CHECK-22 |
| `html.head-closed-early` | an element closes `<head>` early. The evidence names the element and its snippet. It is a warning even with nothing after it, because the next head tag a CMS adds will be ignored | warning | CHECK-18/04/24 |
| `html.structure-invalid` | `<head>` or `<body>` is missing or repeated, or `<head>` comes after `<body>`. The evidence names which | info | new |

The other affected rules are revised on the same ruleset bump:

- `security.mixed-content` widens to the new reference kinds.
- `head.tags-outside-head` adds social tags.
- `head.directives-outside-head` and `head.tags-outside-head` carry the head-closing
  element in their evidence when there is one, so the effect points at its cause.
- `images.missing-alt` gains the image sample.
- Link rules that read anchor text now see image alt.

### Gate 26b

Full suite and harness green with 0 skipped. A crawl from before the extraction bump
gets "not measured" from every 26b rule, never a pass. A lavishalice re-crawl (600
pages) with:

- peak RSS no more than 10% above Phase 25's 223.9 MB;
- average `pages` row growth measured and reported, with a 2 KB per-row budget for
  the new columns combined;
- each new rule's findings reviewed for false positives.

## 26c — Multi-source hreflang and sitemap limits

- **Hreflang from the HTTP `Link` header:** parsed at write time from the stored
  header into `hreflang` rows with `source='header'`.
- **Hreflang from sitemap `xhtml:link`:** written as `source='sitemap'` rows tied to
  the page they describe. Streamed: this must not widen the in-memory sitemap entry
  list.
- Every existing `hreflang.*` rule reads all three sources. A disagreement between
  sources is reported as `hreflang.source-conflict` (warning, CHECK-24).
- **Sitemap membership:** a URL listed in several sitemaps is kept rather than deduped
  away at write time (side table), feeding `sitemap.url-in-multiple` (info, CHECK-08).
- **Sitemap size:** the 10 MB document cap moves to the protocol's 50 MB uncompressed,
  **streaming** rather than buffering. Today a legal 10–50 MB sitemap is dropped as
  "oversized" and its URLs disappear from every sitemap rule. `sitemap.oversized`
  (warning, CHECK-08) fires only above the protocol limit.

### Gate 26c

Full suite green. The 50k memory gate re-run: peak at or below 512 MB, with no
increase attributable to sitemap parsing. A crawl of a multilingual site that uses
sitemap hreflang: `https://www.hurtigruten.com/en/sitemaps/en/sitemap.xml` (owner,
2026-11-05). Checked that day: one `urlset`, 568 URLs, 6,335 `xhtml:link` alternates
(about 11 locales per URL, `x-default` included), 0.9 MB. The gate crawl is scoped and
polite (robots, crawl-delay, the per-host governor).

## Deferred and dropped

- **Deferred to Phase 30:** OG/X image dimensions and incorrectly sized images (these
  need image dimensions or layout); mixed content injected by JavaScript (a
  rendered-DOM question).
- **Dropped (no audit value):**
  - meta keywords
  - `noodp` / `noydir`
  - `noarchive` and `notranslate` as findings (they stay visible as facts)
  - protocol-relative links
  - image `title` attribute
  - "multiple H2"
  - CSS background images
  - broken `#fragment` bookmarks
  - `server` / `x-powered-by` disclosure
  - COOP / COEP / CORP
  - cookies
- **Dropped (owner, 2026-11-05):** readability scores and custom extraction. They are
  not needed for a cloud audit. With no HTML store, a page value the agent wants is
  read from the live page.
- **Already covered:** Google's 15 MB HTML limit. Any HTML page over the fetch cap
  (2 MiB) is already a classified `too_large` row.

## Surface

No new API or MCP fields. New rule ids appear in existing issue listings. Before each
sub-phase's gate, `docs/talos-surface.md`, both skills and the checklist name the new
ids.

## Calls I made (owner to check)

1. Split into 26a / 26b / 26c, ordered cheapest first, each with its own gate.
2. SF filters that are facts, or that are obsolete, get no rule (listed under Dropped).
3. One `security.headers-missing` rule with the missing header named in its evidence,
   instead of five rules. HSTS has its own rule because it matters more.
4. Pixel-width checks are new rule ids. The glyph table is measured by our own
   script in Chromium.
5. Calibration is a black-box SF run on the fixture site, done in the 26a gate.
   Thresholds SF doesn't publish are taken from that run.
6. Every parser addition goes into a single extraction bump (26b), so old crawls need
   one re-crawl.
7. Image link anchor text gains the `alt` text. This changes some existing link rules'
   output on 26b's ruleset bump.
8. The non-descriptive anchor list is English only to start.
9. Phase 26b's storage budget is 2 KB per page row, which is why the image sample
   stops at 10.

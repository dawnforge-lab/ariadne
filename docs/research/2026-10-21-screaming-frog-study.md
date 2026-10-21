# Screaming Frog study — where Ariadne assumes and SF has proven behaviour

Date: 2026-10-21 · Ariadne at 1f5a2d6 (ruleset 0.17.0) · SF SEO Spider 24.3 (docs) / 24.1 (installed)

Sources: SF public user guide, issues library (320 issues, type + priority read from
SF's own labels), release notes 20–24, and the installed CLI's `--help` output. No SF
code was inspected; all descriptions are our own words. Raw research in the session
scratchpad: `sf-feature-map.md`, `sf-cli-surface.md`.

The question is not "what features does SF have" — Ariadne already has the core. It is:
**where did we pick a number, a definition or a behaviour on our own, and what does a
crawler that has been used on millions of sites do in the same place?**

---

## 1. Defects — Ariadne breaks its own rules where SF doesn't

| # | What Ariadne does | What SF does | Why it matters |
|---|---|---|---|
| D1 | Internal links to robots-disallowed URLs are **dropped at enqueue** (`src/crawl/loop.ts:1201`) — no page row, no finding. | "Internal Blocked by Robots.txt" — Warning / **High**, listed with inlinks. | Violates hard rule 7 (no silent skip). A Disallow on a money section is one of the costliest real-world errors and we cannot see it. The link rows exist; the target gets nothing. |
| D2 | Pages whose fetch ended `timeout`, `network_error`, `too_large` or `unsupported_encoding` get a classified row but **no finding and no marker** — `src/rules/page/status.ts` covers only `server_error` and `blocked`; `link-targets.ts` only 4xx/5xx. | "Internal No Response" — Issue / **High**; "HTML Document Over 2MB" — Issue / High. | The row exists (rule 7 half-honoured) but the report is silent, so a reader sees a clean audit. Also: our body cap is 1 MiB, so 1–2 MiB pages are unanalysed while SF's line is 2 MB. |

(An earlier draft listed a D3 — empty `alt=""` lumped with a missing attribute. That was
wrong: the analyzer counts only an absent `alt` (`page-analyzer.ts:1279`). SF's separate
"Missing Alt Text" (empty alt, Issue / Low) remains a possible addition, not a defect.)

## 2. Thresholds we invented vs SF's defaults

| Check | Ariadne | SF default | Recommendation |
|---|---|---|---|
| Title too short | < 10 chars | < 30 chars **and** < 200 px | Adopt 30. 10 catches almost nothing. |
| Title too long | > 60 chars | > 60 chars **and** > 561 px | Keep 60; add pixel width (see §4). Truncation is a pixel fact, not a character fact. |
| Meta description long | > 160 | > 155 chars / > 985 px | Adopt 155 + pixels. |
| Meta description short | < 70 | < 70 / < 400 px | Same number; add pixels. |
| H1 / H2 length | none | > 70 chars | Cheap add (we store `h1_text`). |
| Thin content | < 150 own words | < 200 words in content area (nav/footer excluded) | Our *method* already matches SF (main-content words). The number is ours — calibrate (§5). |
| Near-duplicate | main-content simhash ≤ 3 / 64 bits | minhash ≥ 90% similarity on content area, indexable only | **Owner-ruled in Phase 8: stays strict-3** (SF-90% parity was explained and declined). Calibration (§6) can *measure* what 3 bits means in SF's % terms; changing it needs a fresh owner ruling. |
| Deep page | click depth > 5 | configurable "high crawl depth" (default not confirmed) | Measure on fixture (§5). |
| Oversized image | > 100,000 bytes | > 100 kB | Aligned. |
| Slow response | > 1,500 ms first response | **no such issue**; response-time histogram only; latency judged via Lighthouse | Our warning is an invention. Either keep as a metric (histogram) or justify the number in the spec. |
| URL length | none | > 115 chars | Cheap add. |
| High internal outlinks | none | > 1,000 | Cheap add (SQL count). |

## 3. Severity model — one axis vs two

SF separates **type** (Issue = fix it / Warning = check it / Opportunity = could improve)
from **priority** (High / Medium / Low = likely impact). Ariadne collapses both into
critical / warning / info. Places where our single label disagrees with SF's pair:

| Rule | Ariadne | SF |
|---|---|---|
| content.soft-404 | critical | Warning / High |
| content.placeholder (lorem) | critical | Warning / High |
| meta-description.missing | warning | Opportunity / Low |
| pages.not-in-sitemap | info | **Issue / Medium** |
| indexability.noindex | info | Warning / **High** |
| images.missing-alt | warning | Issue / Low |
| sitemap.non-indexable | critical | Issue / Medium |
| title.too-long | info | Opportunity / Medium |

Lesson: "is it definitely wrong?" and "how much does it cost?" are different questions.
A noindex is not wrong (info is right) but when it is wrong it is catastrophic (High).
Consider adding `priority` beside `severity` rather than recalibrating severity again
(Phase 16 already did that once).

## 4. Whole classes of check SF has learned to need

Ranked by evidence value for Ariadne's evidence layer; all are tokenizer- or SQL-only
(no DOM, no fetch in rules).

1. **"Outside `<head>`" family** — SF flags title, meta description, canonical, robots and
   hreflang placed outside the head (all Issue / High). Browsers and Google close the head
   at the first invalid element, so a canonical after a stray `<img>` in head is ignored.
   Ariadne's streaming analyzer can track "head implicitly closed" cheaply. Pair with SF's
   Validation checks: invalid elements in head, multiple/missing head/body.
2. **Raw vs rendered divergence on directives** — "noindex only in original HTML",
   "canonical mismatch raw vs rendered" (both Issue / High), title/H1/meta changed by JS.
   We already store `rendered_canonical`, `rendered_title`, `rendered_h1_count`; the rules
   don't exist. Note the render pass is a 5% sample, so these are sample findings.
3. **Hreflang depth** — SF has 12 checks vs our 5: non-canonical return links, hreflang URL
   not the canonical, inconsistent code on the return link, same code with two URLs,
   non-200 alternates, unlinked alternates. And SF reads hreflang from HTML, **HTTP
   header and sitemap**; we read HTML only (the `hreflang.source` column already allows
   the other two).
4. **Canonical hygiene** — relative canonical, canonical with `#fragment`, invalid
   attribute in the link element, canonical target unlinked, canonical chains.
5. **Pagination integrity** — non-200 next/prev, loops, non-reciprocal sequence, multiple
   next/prev. Also SF's option to **exclude page 2+ from duplicate checks**; our duplicate
   rules don't (no pagination handling in `field-duplicates.ts`), so paginated series
   produce duplicate-title noise.
6. **Link graph quality** — dead-end pages (no internal outlinks), pages linked only from
   non-indexable pages, nofollow-only inlinks, empty and non-descriptive anchor text,
   links to localhost, **uncrawlable links** (`<span href>`, `onclick`, `javascript:` —
   new in SF 24). All SQL over `links` except uncrawlable, which needs the analyzer to
   record them.
7. **External link status** — SF checks outbound links (Warning / Low). We store them,
   never fetch. HEAD-only through the existing resource gate would cover it.
8. **Sitemap protocol limits** — > 50,000 URLs or > 50 MB per file (Issue / High); URL in
   multiple sitemaps. We already hold the data.
9. **Security** — mixed content and insecure form actions are Issue / High; the header
   checks (HSTS, CSP, XCTO, XFO, Referrer-Policy) are all **Low**. This confirms our spec's
   "free rules" list should start with mixed content, not headers.
10. **Pixel widths** for titles/descriptions — needs a font-metric table (Arial ~20px for
    titles, ~14px for snippets). Pure function, no rendering.
11. **Structured data formats** — Microdata and RDFa extraction, and SF's split between
    *Schema.org validity* and *Google rich-result eligibility*. Larger piece of work.

Not recommended for the engine (agent or Talos territory, or deliberately out of scope):
spelling/grammar, readability, embeddings/semantic similarity, AI prompts, carbon rating,
GA4/GSC/backlink integrations, scheduling, visualisations, AMP (dead format).

## 5. Crawl behaviour assumptions

| Area | Ariadne | SF | Note |
|---|---|---|---|
| Render viewport | desktop 1280×900 | Googlebot mobile/desktop presets | Google indexes mobile-first; a mobile render is the one that matters for CSR checks. |
| Render coverage | 5% sample, max 500 | every page in JS mode (opt-in) | Sampling is a cost decision; findings from it should say "in sampled pages". |
| Rendered links | counted, not stored | stored with origin raw / rendered / both | Needed for "JS-only links" per page and correct orphan/depth on CSR sites. |
| Scope controls | none | include/exclude regex, subfolder, per-subdomain caps, list mode | List mode matters for Talos (re-check a set of URLs after fixes). |
| Auth / headers | none | basic/digest, form login, custom headers | Staging audits. |
| "Judge indexable only" | always (Phase 22 judged cohort) | an option ("ignore non-indexable URLs for issues") | Independent confirmation that Phase 22's model is the industry model. |

## 6. Calibrating instead of guessing — the black-box programme

For each number in §2 that we keep, settle it by measurement, not opinion. Build fixture
pages that straddle the line, crawl them once **manually** with SF and with Ariadne, record
both verdicts, keep the fixture as a regression test with *our* chosen behaviour.
(Manual runs only: SF EULA 3.4(f) forbids using SF to build an automated service, so SF
never goes into CI.)

Priority calibration sets:
1. **Near-duplicate** — page pairs at 98/95/91/89/85/80% shared main text, with and without
   shared chrome. Maps our simhash distance to SF's % and checks chrome exclusion.
2. **Thin / low content** — 140, 160, 190, 210 own words with a heavy nav.
3. **Soft 404** — 200 pages with "not found" wording at varying lengths, empty search
   results, empty category pages.
4. **Titles/descriptions** — wide-glyph vs narrow-glyph strings around 561 px / 985 px.
5. **Head closing** — canonical after an `<img>`, `<div>`, `<noscript>` in head.
6. **Crawl depth** — a linear chain of 12 pages to see where "high crawl depth" fires.

## 7. Suggested order

1. D1–D2 (defects, small).
2. Thresholds §2 that are pure number changes (title 30, description 155) — ruleset bump.
3. Outside-head family + raw/rendered directive divergence (highest-impact new evidence).
4. Calibration programme §6 for near-dup / thin / soft-404.
5. Hreflang depth + sources; pagination exclusion from duplicates.
6. Priority axis beside severity.
7. Link graph quality, external links, sitemap limits, mixed content, pixel widths.

## Appendix — side finding (not Ariadne work)

The owner's `sf-audit` / `sf-cli` skills drift from SF 24.1: `Page Titles:Over 60
Characters` is now `Over X Characters`; image filters are spelled `kB`; CHECK-39 calls a
non-existent `--save-report "Content:Near Duplicates"` (it is an export tab / bulk
export); launcher path is macOS-only.

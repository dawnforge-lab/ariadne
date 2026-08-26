# Backend crawl and audit engine: build spec

Target: an agent-driven backend crawler and audit engine that satisfies sections
Pre-Crawl and 1 to 11 of the existing `sf-audit` checklist (47 checks), runs
unattended on a VM, and emits output that the existing `sf-report`,
`sf-action-plan` and presentation skills consume unchanged.

Not a Screaming Frog clone. SF flags everything because a human reads a grid.
Here an agent reads the output, so the system splits in two:

- **Evidence layer (deterministic).** Crawler, rules, metrics. Produces facts:
  this URL 404s, these 340 URLs share a title, inlinks median is 4, these 12
  page types exist. Reproducible, testable, versioned.
- **Judgement layer (the agent).** Reads evidence, decides severity in context,
  identifies root cause, writes the narrative. Never re-derives facts.

The split matters because roughly a third of the checklist asks for judgement
(root-cause classification, intent match, E-E-A-T, opportunity sizing) that no
rule engine can produce. Encoding those as rules is how you get the
stub-rule problem. Leave them to the agent and give it good evidence instead.

---

## 1. Foundation

**TypeScript, own crawl loop, Postgres, four small libraries.**

TypeScript because the one piece genuinely worth borrowing (OpenSEO's streaming
extractor and SSRF policy) is MIT TypeScript. Python would mean rewriting it for
a crawl-framework advantage that does not repay the cost.

**No crawl framework.** The loop is ours: a frontier table in Postgres, a
worker pool with a semaphore, `undici` for fetching. Roughly 400 lines. The
reasoning is maintenance surface, not purity — Crawlee is excellent, but its
headline features (proxy rotation, browser pooling, anti-blocking, autoscaling
across hostile targets) are aimed at scraping sites that do not want to be
scraped. We crawl client sites, usually with permission, where politeness
matters more than throughput. Paying a large dependency for features we will
not use, in the one component most likely to need bespoke tuning, is the wrong
trade. Postgres as the frontier also makes resume and progress reporting fall
out for free.

The trade-off: a hand-rolled loop means owning retry semantics,
timeout handling, graceful shutdown and resume. All four need customising for
this use case anyway, and 400 lines we wrote beats 50k lines we did not when a
client crawl misbehaves.

Dependencies, deliberately small and boring:

- **undici** — fetching, with manual redirect handling.
- **htmlparser2** — streaming tokenizer. Never build a DOM on the hot path.
- **robots-parser**, **fast-xml-parser** — robots.txt and sitemaps.
- **Playwright** — render pass only, a few per cent of URLs.
- **Postgres** (with drizzle or equivalent) — pages, links, issues, metrics.
  Every cross-page check is SQL.

cheerio stays in devDependencies only, as a parity oracle for the extractor
tests, which is how OpenSEO uses it.

**Memory contract.** RAM must be O(concurrency), not O(URLs):

- stream-parse each response, emit a row, discard the body;
- frontier and dedup set in the Postgres frontier table, never a RAM hash set;
- cross-page checks as SQL, never in-memory joins;
- near-duplicates via a 64-bit simhash column, never a shingle store;
- cap per-page collections (links, images) as OpenSEO does.

Target: 1M URLs under 512MB resident, flat as the site grows. Verify with a
50k-page crawl under 512MB as the first milestone gate.

---

## 2. Data contract

Beyond OpenSEO's `CrawledPageResult`, the checklist demands fields it does not
capture. Full schema:

### `crawls`
`id, site_url, config_jsonb, ruleset_version, started_at, finished_at, status,
pages_crawled, pages_total, render_pass_count`

### `pages`
One row per URL.

```
id, crawl_id, url, url_normalised, page_type, status_code, fetch_class,
content_type, redirect_url, depth, discovered_via,
title, meta_description, canonical_html, canonical_header, canonical_count,
robots_meta, x_robots_tag, is_indexable, og_title, og_description, og_image,
h1_count..h6_count, heading_order[], word_count, text_ratio,
content_hash, simhash, structured_data_parse_errors,
response_time_ms, html_bytes, dom_size,
images_total, images_missing_alt, images_missing_dimensions,
has_amp, has_viewport, has_lorem_ipsum, rel_next, rel_prev,
rendered (bool), rendered_word_count, rendered_link_count
```

New versus OpenSEO: `url_normalised` (lowercased, trailing slash stripped, for
case and slash variant detection), `page_type`, `simhash`, `text_ratio`,
`dom_size`, `rel_next`, `rel_prev`, `discovered_via`, and the `rendered_*`
columns for the raw-versus-rendered diff.

Two columns this inventory once listed are gone, and five signals the rules
need have been added, all in built code:

- `redirect_hops` and `in_sitemap` were **dropped** (Phase 2 groundwork,
  `c791084`). Nothing ever wrote them, and a rule reading a column that is
  always null is a rule that always passes — hard rule 1. Both facts are still
  available as queries: hops from the redirect chain, sitemap membership from
  `sitemap_urls.page_id`.
- `canonical_count` — how many `<link rel=canonical>` elements the HTML
  declared. `canonical_html` keeps the first; "more than one canonical"
  (CHECK-18) is a finding a single-value column cannot express.
- `structured_data_parse_errors` (Phase 1) — JSON-LD blocks that would not
  parse. A count, not a silence.
- `images_missing_dimensions` — `<img>` without both width and height, the CLS
  signal (CHECK-49).
- `has_viewport` — `<meta name=viewport>` present (CHECK-52).
- `has_lorem_ipsum` — placeholder copy shipped to production (CHECK-40).

### `links`
`crawl_id, source_page_id, target_url, target_page_id, anchor, rel, is_internal,
is_nofollow, position` — index on `target_url` and `target_page_id`. This table
is the one that must stay on disk and be queried, never loaded. It is what SF
holds in heap.

### `hreflang`
`crawl_id, page_id, hreflang_code, target_url, target_page_id, source
('html'|'sitemap'|'header')` — one row per declaration. Return-link
verification is a self-join; SF's "missing return links" is this query.

### `structured_data`
`crawl_id, page_id, schema_type, raw_jsonb, field_presence_jsonb`. One row per
`@type` found. A boolean flag is useless for CHECK-43 to CHECK-46, which need
types per page type plus field-level completeness.

### `sitemap_urls`
`crawl_id, url, sitemap_source, lastmod, page_id` — retained so CHECK-07 and
CHECK-09 are joins rather than set arithmetic in memory.

### `url_params`
`crawl_id, param_name, occurrence_count, sample_urls[], is_tracking` — the
inventory CHECK-27 and CHECK-28 need.

### `issues`
`crawl_id, rule_id, page_id, severity, dedupe_key, details_jsonb` — the flag
output.

### `metrics`
`crawl_id, metric_id, scope ('site'|'page_type'), scope_value, value_jsonb` —
the distribution and cohort output. Half the checklist asks for numbers, not
pass or fail, and those do not fit the issues table.

### `page_type` derivation

Everything in the checklist groups by page type (product, collection, blog,
info). Derive it once with URL template detection (OpenSEO's
`detectUrlTemplate`) plus optional client-supplied path patterns, and store it.
Without this column, a dozen checks cannot be answered.

---

## 3. Rule engine contract

Three rule kinds. Same registry, different signatures.

```ts
type PageRule = {
  kind: 'page'
  run: (page: PageRecord) => Finding[]        // pure, no DOM, no db
}

type QueryRule = {
  kind: 'query'
  run: (db: Db, crawlId: string) => Promise<Finding[]>   // SQL only
}

type MetricRule = {
  kind: 'metric'
  run: (db: Db, crawlId: string) => Promise<Metric[]>    // distributions, cohorts
}
```

Every rule carries:

```ts
{
  id: string                  // 'canonical.non-200-target'
  checkIds: string[]          // ['CHECK-19'] — traces to the checklist
  category: RuleCategory      // the closed union in src/rules/registry/types.ts
  severity: 'critical' | 'warning' | 'info'
  title: string
  explanation: string         // client-facing, plain English
  howToFix: string            // client-facing, actionable
  rulesetVersion: string
}
```

`checkIds` is the important field. It makes coverage against your own checklist
a query, and it lets the report skills group findings the way the deliverables
already do.

### Outcome contract

A `Finding`:

```ts
{ ruleId, pageId, pageUrl, severity, evidence: Record<string, unknown>, dedupeKey }
```

`evidence` is what the agent narrates from, so put the specifics in it: the
conflicting canonical values, the redirect hop list, the duplicate group peers,
the missing schema fields. A finding without evidence forces the agent to
re-crawl to write a sentence about it.

A `Metric`:

```ts
{ metricId, scope, scopeValue, value: { min, median, mean, max, distribution, cohorts } }
```

Both tables feed the deliverables directly. Shape `issues` to match what
`sf-action-plan` emits per tab (issue, severity, affected URLs, context, fix)
and the spreadsheet generator needs no adapter.

---

## 4. Rule map: 47 checks

Source column: what to lift. OS = OpenSEO (MIT, code), SN = SEOnaut (MIT, copy
and check logic to port from Go), SM = SEOmator taxonomy (MIT, coverage
reference), NEW = write it, AGENT = judgement layer, not a rule.

### Pre-crawl
| Check | Rule / output | Kind | Source |
|---|---|---|---|
| 01 JS-disabled rendering | raw vs rendered diff per sampled page; `content.csr-dependent` | metric + page | NEW |
| 02 Filters HTML or JS | link count delta on filter URLs, raw vs rendered | metric | NEW |

### 1. Crawlability and robots
| 03 robots.txt valid, not over-blocking | fetch, parse, report disallow coverage vs crawled set | query | OS + NEW |
| 04 Meta robots and X-Robots-Tag | `indexability.noindex`, `indexability.header-conflict` | page | OS + SN |
| 05 Geo/IP redirects, bot blockers | `crawl.blocked` from fetch classification | page | OS |

### 2. Sitemaps
| 06 Sitemap exists, valid, in robots | `sitemap.missing`, `sitemap.invalid`, `sitemap.not-in-robots` | query | NEW |
| 07 Only indexable 200 URLs | join `sitemap_urls` to `pages`: `sitemap.non-200`, `sitemap.non-indexable`, `sitemap.redirected` | query | SN |
| 08 Sitemap structure (large sites) | shard count, URLs per shard, 50k/50MB breaches | metric | NEW |
| 09 URLs not in sitemap | anti-join: crawled indexable 200 not in `sitemap_urls` | query | NEW |

### 3. Redirects and errors
| 10 Chains, loops, JS redirects, volume | `redirect.chain`, `redirect.loop` (OS), `redirect.js` (render pass), redirect ratio metric | query + metric | OS + NEW |
| 11 Broken internal links | join `links` to `pages` on 4xx | query | OS |
| 12 5xx errors | `http.server-error` | page | OS |
| 13 Soft-404s | 200 + thin + soft-404 signal phrases + template match to known 404; `content.soft-404` | query | NEW |

### 4. Host and protocol
| 14 HTTP to HTTPS route | pre-crawl probe of 4 host variants, record hop chains | query | NEW |
| 15 Primary host choice | same probe: which variants 200, which redirect, staging/legacy hosts reachable | query | NEW |

These two are a deliberate probe step before the crawl, not a crawl output.
Probe `http://apex`, `https://apex`, `http://www`, `https://www` plus any
client-supplied legacy hosts, record the chains, done.

### 5. Canonicals and indexability
| 16 Self-referential canonicals | `canonical.missing-self-reference` | page | SN |
| 17 Canonicalised URLs audit | `canonical.points-elsewhere` + cohort by page type | page + metric | OS |
| 18 Conflicting signals | `canonical.html-header-conflict`, `canonical.multiple` | page | OS + SN |
| 19 Canonical to non-200 / non-indexable | join canonical target to `pages` | query | NEW |
| 20 Cross-domain canonicals | host comparison | page | SN |
| 21 Canonical + noindex conflict | `directive.canonical-noindex-conflict` | page | SN |

### 6. Pagination
| 22 HTML-based, crawlable | `rel_next`/`rel_prev` presence, paginated URLs reached via links vs only via pattern | query | SN |
| 23 Canonical strategy on paginated | canonical of page 2+ points to itself or to page 1 (flag either, agent decides) | query | NEW |

### 7. Hreflang
| 24 Complete sets with return links | self-join `hreflang`: `hreflang.missing-return-link`; coverage metric (pages with hreflang / indexable pages, by page type) | query + metric | SN + NEW |
| 25 Codes and x-default | code validity against ISO lists, `hreflang.invalid-code`, `hreflang.missing-x-default` | page | SN |
| 26 Hreflang to non-indexable/redirected | join target to `pages` | query | SN |

### 8. URL parameters
| 27 Parameter audit and canonical handling | `url_params` inventory + canonical behaviour per param | metric + query | NEW |
| 28 Tracking parameters | classify utm/gclid/fbclid/etc, flag internal links carrying them | query | NEW |
| 29 Faceted navigation risk and opportunity | evidence only: param combination counts, crawl volume by facet, indexable facet URLs | metric | NEW + AGENT |
| 30 Case and trailing-slash normalisation | group by `url_normalised` having >1 distinct `url` | query | SN |

### 9. Internal linking
| 31 Crawl depth to key pages | `structure.deep-page` + depth distribution by page type | page + metric | OS |
| 32 Orphan pages | anti-join `links` on target, gated on crawl completeness | query | OS |
| 33 Unique inlinks distribution | min/median/mean/max, bottom 20, top 20, by page type | metric | NEW |
| 33b Product discovery source | inlink sources grouped by source page type | metric | NEW |
| 34 Nav and key links in raw HTML | raw link count vs rendered link count on sampled pages | metric | NEW |

### 10. On-page
| 35 Titles | missing, duplicate, too long, too short | page + query | OS |
| 36 Meta descriptions | missing, duplicate, length bounds | page + query | OS |
| 37 H1 and hierarchy | missing, multiple, level skip, duplicate H1 | page | OS + SN |
| 38 Content quality and intent match | evidence: word count, text ratio, template boilerplate share by page type | metric | AGENT |
| 39 Near-duplicates | simhash banding to pairs + similarity buckets + pair-type matrix (product↔product etc); root cause is the agent's job | query + metric | NEW |
| 40 Thin or placeholder content | `content.thin`, `content.placeholder` | page | OS + SM |

### 11. Structured data
| 43 Schema audit: types, gaps, opportunities | types-per-page-type matrix from `structured_data`; gap versus expected-profile table; opportunity is the agent's | metric + query | NEW |
| 44 Product schema completeness | field presence against required/recommended sets | query | NEW |
| 45 BreadcrumbList | presence by page type | query | NEW |
| 46 Review and rating markup | presence plus policy sanity (self-serving review flags) | query | NEW |

### Deliberately AGENT, not rules
CHECK-38 intent match, CHECK-41 E-E-A-T signals, CHECK-42 expired product
handling, the opportunity halves of CHECK-29 and CHECK-43, and the root-cause
classification in CHECK-39. The engine supplies the evidence tables; the agent
writes the finding. Do not fake these as rules.

### Free rules worth adding beyond the checklist
SEOnaut carries checks the checklist does not name but clients notice: security
headers (HSTS, CSP, X-Content-Type-Options), oversized images, missing `img`
width/height, insecure and mixed-content forms, DOM size, localhost links in
production, duplicated element ids, missing viewport, external broken links,
metas in body. All cheap given the data you already hold. Port them.

---

## 5. Rendering strategy

Two-pass, budget 1 to 5% of URLs.

Pass one: HTTP crawl everything. Pass two: re-render a per-page-type sample
plus any URL that trips a suspicion filter — low word count with large HTML,
zero links, empty title with large body, or framework markers
(`__NEXT_DATA__`, `data-reactroot`, `ng-app`). Store `rendered_*` columns and
diff. The diff is the evidence for CHECK-01, 02, 10 (JS redirects) and 34, which
is four checks off one mechanism.

---

## 6. Validation

Fixture-driven, no desktop tool in the loop.

1. **Fixture site.** Fork `badseo.dev` (MIT). Every rule must fire on a page
   built to break it, asserted in CI. This is the gate that prevents shipping
   rules that never fire.
2. **Golden crawls.** Freeze the crawl output for two or three real sites as
   fixtures, then assert rule output against them. Catches regressions when the
   parser or a rule changes without needing network access.
3. **Rule coverage query.** Every checklist check id must be claimed by at least
   one rule or explicitly marked AGENT. Fail CI on an unclaimed check.
4. **Optional one-off calibration.** If a sanity check against SF is ever
   wanted, use existing `.dbseospider` files from past audits rather than new
   crawls. Development-time only, not part of the pipeline.

---

## 7. Build order

1. Crawl loop, schema, streaming extraction. Gate: 50k pages under 512MB.
2. Page rules ported from OpenSEO plus SEOnaut's page-level set. Fixture site in CI.
3. Query rules: the joins are where most of the client value sits (broken links,
   orphans, canonical targets, hreflang return links, sitemap mismatches).
4. Metric rules: distributions and cohorts. This is what makes reports read as
   analysis rather than a defect list.
5. Render pass.
6. MCP tools, mirroring the existing SF skill vocabulary so current agent
   workflows keep working.
7. Reports last. They already exist.

Milestone worth defending: all 47 crawl-derived checks claimed, fixture site
green, and one real client site audited end to end into the existing
`sf-report` and `sf-action-plan` output.

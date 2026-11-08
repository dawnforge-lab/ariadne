# Phase 27a gate: judgement and overviews

Date: 2026-11-08. Spec: `docs/superpowers/specs/2026-11-08-phase-27-agent-control-plane-design.md`
(the "27a — Judgement and overviews" section and "Gate 27a"). Plan:
`docs/superpowers/plans/2026-11-08-phase-27a-judgement-and-overviews.md`. Branch
`worktree-phase-27`, built on `cb63104` (the design commit over `bc9ce32`, PR #24's merge).
Every figure below was measured on the code of `4b008a1` (Task 9's last commit) plus this
task's documentation commit (`db91923`), which changes no behaviour. Its `src/` edits
are text only: the `crawl_status` description in `src/api/mcp.ts`, the
`CrawlDetail.findingsCount` docblock in `src/api/service.ts`, and item 9 of the
version note in `src/rules/registry/registry.ts`; its test edit widens the identifier
guard's vocabulary. The one behaviour change after the gate, the fix in §7, makes the
Crawl Overview's `crawl_status` reads sequential on its transaction and moves no
number. The gate is
**local database work only**: the stored lavishalice crawl was re-judged and read, and
nothing was crawled, rendered or fetched. Raw outputs and the gate scripts are in the
git-ignored SDD workspace (`.superpowers/sdd/2026-11-08-phase-27a-judgement-and-overviews/gate27a/`).

**Verdict: all five clauses pass.** Ruleset 0.23.0 with **188 rules** (72 page / 102
query / 14 metric; no rule added, removed or re-worded at the defaults), migrations 0031
(the judgement block and the run stamp), 0032 (the stamp backfilled on every judged
crawl) and 0033 (added by the final review: every stamp's thresholds rewritten to the
effective values, §5 (e)). Every one of the 174 finding rules has a type and a priority. Against Screaming
Frog's Issues Overview, 132 map to an SF issue: 120 agree, and 12 differ, each for a
stated difference in what the rule reports. On the stored lavishalice crawl the Issues
Overview's `urls` equals the distinct URL count of `issue_urls` for all 46 rules that
fired, and every Crawl Overview `urls` entry equals the `crawl_status` field it comes
from. A disable, a retype and a reprioritise showed on every surface with no run, a
`SLOW_MS` override changed `performance.slow-response` from 0 to 4 findings only after
the re-run, and the crawl was left with no overrides, re-judged, and its 3,202 findings
rule for rule as before.

## Gate clauses

| # | clause | result | where |
|---|---|---|---|
| 1 | full suite and harness green, 0 skipped; `tsc` clean | **pass**: 134 files / 3,759 tests, 0 failed, 0 skipped; `tsc` clean | §1 |
| 2 | the triage table covers every finding rule; the SF comparison table is in the gate doc | **pass**: 174 rows for 174 finding rules, pinned by `test/rules/triage.test.ts`; 132 mapped, 120 agree, 12 differ (each with its reason), 42 unmapped | §2 |
| 3 | re-judge the stored lavishalice crawl; Issues Overview counts equal `issues_list` rule by rule | **pass** (as Ruling 9 restates it): 46 of 46 rules, `urls` = distinct URLs `issue_urls` lists; `issues_list.count` equal too on this crawl; 4 site-wide rules listed | §3 |
| 4 | Crawl Overview totals reconcile with `crawl_status` | **pass** (as Ruling 10 restates it): each of the 5 `urls` entries equals its field; the six page partitions each sum to `pagesScanned` (602); the issues grid sums to `findingsCount` (3,202) | §4 |
| 5 | one override round trip: disable / retype / reprioritise visible at once on every surface; a threshold leaves findings unchanged and `judgementStale` true until the re-run, then findings, copy and stamp agree | **pass**: 25 of 25 checks | §5 |

## 1. Clause 1: suite and types

| | |
|---|---|
| `npm test` (`DATABASE_URL` set) | **134 files / 3,759 tests, 0 failed, 0 skipped** (287.7 s, 2026-11-08 20:14 UTC, `gate27a/fullsuite-1.log`), on the final code and docs of this task. The known load flake (`test/crawl/renderer.test.ts` "never predicts a URL twice") did not appear |
| `npx tsc --noEmit` | clean (`gate27a/tsc.log`) |
| baseline at the branch point (`cb63104`) | 122 files / 3,495 tests |
| phase delta | +12 files, +264 tests |
| ruleset | **0.23.0** (one bump, in Task 1; the version note in `src/rules/registry/registry.ts` carries items T1–T10) |
| registry | 188 rules: 72 page / 102 query / 14 metric; 33 critical / 66 warning / 89 info; 16 markers (unchanged from 0.22.0) |
| `rules_catalog` (no crawl id) | **200,260 bytes** (16 markers at 2,487, 14 tables at 5,620). The same measurement over `cb63104` reproduces 0.22.0's 194,186 to the byte; the 6,074 between them are `type` and `priority` on the 174 finding rules (`gate27a/measure-catalog.mts`) |
| migrations | 0031 (schema), 0032 (data), 0033 (data, final review: stamps hold effective thresholds); applied with `npm run db:migrate` |
| MCP tools / HTTP routes | 22 / 22 (`crawl_config_get`, `crawl_config_set`, `issues_overview`, `crawl_overview` new); CSV views 11 (`issues_overview`, `crawl_overview` new) |

The harness (`test/fixtures/harness.test.ts`) is part of `npm test` and ran in both runs.

## 2. Clause 2: the triage table

`src/rules/registry/triage.ts` holds one row per page and query rule, 174 in all: the
registry has 72 page and 102 query rules, and the plan's "172" was a slip (Ruling 2).
`test/rules/triage.test.ts` "gives every page and query rule a type and priority",
"gives metric rules neither, and has no row for them", "has no row for a rule the
registry lacks", "files every marker as warning / low" and "keeps the rows in rule-id
order, one per page and query rule" pin the coverage both ways, and `defineRule` refuses
a finding rule with no row at registry load ("refuses a page or query rule with no row,
naming it").

**The comparison with Screaming Frog.** Regenerated at the gate with
`npx tsx scripts/triage-vs-sf.ts <SF Issues Overview CSV>` and byte-identical to the
table Task 1 produced. The CSV is black-box output of SF's own run on the fixture site
(the 26a calibration's), kept in the git-ignored workspace; only its Issue Name, Issue
Type and Issue Priority columns were read, and none of its description or fix text is in
this repository. SF's type and priority are the reference, and SF's value stands unless
the rule's own semantics differ from SF's issue (the rule in `triage.ts`'s header).

**132 mapped, 120 agree, 12 differ, 42 unmapped.**

| rule | sfIssue | SF type/priority | ours | agrees |
|---|---|---|---|---|
| `canonical.fragment` | Canonicals: Contains Fragment URL | issue / high | issue / high | yes |
| `canonical.html-header-conflict` | Canonicals: Multiple Conflicting | issue / high | issue / high | yes |
| `canonical.missing` | Canonicals: Missing | warning / medium | warning / medium | yes |
| `canonical.multiple` | Canonicals: Multiple | warning / low | warning / low | yes |
| `canonical.non-200-target` | Canonicals: Non-Indexable Canonical | issue / high | issue / high | yes |
| `canonical.non-indexable-target` | Canonicals: Non-Indexable Canonical | issue / high | issue / high | yes |
| `canonical.points-elsewhere` | Canonicals: Canonicalised | warning / high | warning / high | yes |
| `canonical.relative` | Canonicals: Canonical Is Relative | warning / low | warning / low | yes |
| `canonical.unlinked` | Canonicals: Unlinked | warning / medium | warning / medium | yes |
| `content.csr-dependent` | JavaScript: Contains JavaScript Content | warning / medium | warning / high | **no** |
| `content.exact-duplicate` | Content: Exact Duplicates | issue / high | issue / high | yes |
| `content.near-duplicate` | Content: Near Duplicates | warning / medium | warning / medium | yes |
| `content.placeholder` | Content: Lorem Ipsum Placeholder | warning / high | warning / high | yes |
| `content.soft-404` | Content: Soft 404 Pages | warning / high | warning / high | yes |
| `content.thin` | Content: Low Content Pages | opportunity / medium | opportunity / medium | yes |
| `directives.restrictive` | Directives: NoSnippet | warning / low | warning / low | yes |
| `directives.unavailable-after` | Directives: Unavailable_After | warning / medium | warning / high | **no** |
| `filters.js-only` | JavaScript: Contains JavaScript Links | warning / medium | warning / medium | yes |
| `h1.duplicate-text` | H1: Duplicate | opportunity / low | opportunity / low | yes |
| `h2.duplicate` | H2: Duplicate | opportunity / low | opportunity / low | yes |
| `h2.missing` | H2: Missing | warning / low | warning / low | yes |
| `h2.too-long` | H2: Over 70 Characters | opportunity / low | opportunity / low | yes |
| `head.directives-outside-head` | Directives: Outside &lt;head&gt; | issue / high | issue / high | yes |
| `head.tags-outside-head` | Page Titles: Outside &lt;head&gt; | issue / high | issue / medium | **no** |
| `headings.h1-missing` | H1: Missing | issue / medium | issue / medium | yes |
| `headings.h1-multiple` | H1: Multiple | warning / medium | warning / medium | yes |
| `headings.h1-too-long` | H1: Over 70 Characters | opportunity / low | opportunity / low | yes |
| `headings.level-skip` | H2: Non-Sequential | warning / low | warning / low | yes |
| `host.http-serves-200` | Security: HTTP URLs | issue / high | issue / high | yes |
| `hreflang.html-lang-mismatch` | Hreflang: Mismatch with HTML Lang Attribute | warning / medium | warning / medium | yes |
| `hreflang.inconsistent-return-code` | Hreflang: Inconsistent Language & Region Return Links | issue / high | issue / high | yes |
| `hreflang.invalid-code` | Hreflang: Incorrect Language & Region Codes | issue / high | issue / high | yes |
| `hreflang.missing-return-link` | Hreflang: Missing Return Links | issue / high | issue / high | yes |
| `hreflang.missing-self-reference` | Hreflang: Missing Self Reference | warning / low | warning / low | yes |
| `hreflang.missing-x-default` | Hreflang: Missing X-Default | warning / low | warning / low | yes |
| `hreflang.multiple-entries` | Hreflang: Multiple Entries | issue / high | issue / high | yes |
| `hreflang.non-indexable-target` | Hreflang: Non-200 hreflang URLs | issue / high | issue / high | yes |
| `hreflang.self-only` | Hreflang: Self Reference Only | issue / high | issue / high | yes |
| `hreflang.unlinked-target` | Hreflang: Unlinked hreflang URLs | issue / medium | issue / medium | yes |
| `html.head-closed-early` | Validation: Invalid HTML Elements in &lt;head&gt; | warning / high | issue / high | **no** |
| `html.head-closed-early-harmless` | Validation: Invalid HTML Elements in &lt;head&gt; | warning / high | warning / low | **no** |
| `html.structure-invalid` | Validation: Missing &lt;head&gt; Tag | issue / high | issue / high | yes |
| `http.no-response` | Response Codes: Internal No Response | issue / high | issue / high | yes |
| `http.no-response-transient` | Response Codes: Internal No Response | issue / high | warning / high | **no** |
| `http.server-error` | Response Codes: Internal Server Error (5xx) | issue / high | issue / high | yes |
| `http.server-error-transient` | Response Codes: Internal Server Error (5xx) | issue / high | warning / high | **no** |
| `images.alt-too-long` | Images: Alt Text Over 100 Characters | opportunity / low | opportunity / low | yes |
| `images.empty-alt` | Images: Missing Alt Text | issue / low | warning / low | **no** |
| `images.legacy-format` | PageSpeed: Improve Image Delivery | opportunity / medium | opportunity / medium | yes |
| `images.missing-alt` | Images: Missing Alt Attribute | issue / low | issue / low | yes |
| `images.missing-dimensions` | Images: Missing Size Attributes | opportunity / low | opportunity / low | yes |
| `images.oversized` | Images: Over 100 kB | opportunity / medium | opportunity / medium | yes |
| `indexability.nofollow` | Directives: Nofollow | warning / high | warning / high | yes |
| `indexability.noindex` | Directives: Noindex | warning / high | warning / high | yes |
| `links.broken-internal` | Response Codes: Internal Client Error (4xx) | issue / high | issue / high | yes |
| `links.high-outlinks` | Links: Pages With High Internal Outlinks | warning / low | warning / low | yes |
| `links.internal-nofollow` | Links: Internal Nofollow Outlinks | warning / low | warning / low | yes |
| `links.localhost` | Links: Outlinks To Localhost | issue / high | issue / high | yes |
| `links.no-anchor-text` | Links: Internal Outlinks With No Anchor Text | opportunity / low | opportunity / low | yes |
| `links.non-descriptive-anchor` | Links: Non-Descriptive Anchor Text In Internal Outlinks | opportunity / low | opportunity / low | yes |
| `links.only-from-non-indexable` | Links: Non-Indexable Page Inlinks Only | warning / high | warning / high | yes |
| `links.orphan` | Sitemaps: Orphan URLs | issue / medium | issue / medium | yes |
| `links.to-server-error` | Response Codes: Internal Server Error (5xx) | issue / high | issue / high | yes |
| `links.uncrawlable` | Links: Pages With Uncrawlable Internal Outlinks | warning / high | warning / high | yes |
| `links.unsafe-target-blank` | Security: Unsafe Cross-Origin Links | warning / low | warning / low | yes |
| `meta-description.duplicate` | Meta Description: Duplicate | opportunity / low | opportunity / low | yes |
| `meta-description.missing` | Meta Description: Missing | opportunity / low | opportunity / low | yes |
| `meta-description.multiple` | Meta Description: Multiple | issue / medium | issue / medium | yes |
| `meta-description.pixel-too-long` | Meta Description: Over 985 Pixels | opportunity / low | opportunity / low | yes |
| `meta-description.pixel-too-short` | Meta Description: Below 400 Pixels | opportunity / low | opportunity / low | yes |
| `meta-description.too-long` | Meta Description: Over 155 Characters | opportunity / low | opportunity / low | yes |
| `meta-description.too-short` | Meta Description: Below 70 Characters | opportunity / low | opportunity / low | yes |
| `mobile.viewport-missing` | Mobile: Viewport Not Set | issue / high | issue / high | yes |
| `nav.js-only` | JavaScript: Contains JavaScript Links | warning / medium | warning / high | **no** |
| `page.html-too-large` | Validation: HTML Document Over 2MB | issue / high | issue / high | yes |
| `pages.not-in-sitemap` | Sitemaps: URLs not in Sitemap | issue / medium | issue / medium | yes |
| `pagination.canonical-to-other` | Canonicals: Canonicalised | warning / high | warning / high | yes |
| `pagination.loop` | Pagination: Pagination Loop | issue / low | issue / low | yes |
| `pagination.multiple` | Pagination: Multiple Pagination URLs | issue / low | issue / low | yes |
| `pagination.next-not-linked` | Pagination: Pagination URL Not in Anchor Tag | issue / high | issue / high | yes |
| `pagination.non-indexable-target` | Pagination: Non-Indexable | warning / high | warning / high | yes |
| `pagination.sequence-error` | Pagination: Sequence Error | issue / low | issue / low | yes |
| `redirect.chain` | Response Codes: Internal Redirect Chain | warning / medium | warning / medium | yes |
| `redirect.js` | Response Codes: Internal Redirection (JavaScript) | warning / low | warning / low | yes |
| `redirect.loop` | Response Codes: Internal Redirect Loop | issue / high | issue / high | yes |
| `redirect.meta-refresh` | Response Codes: Internal Redirection (Meta Refresh) | warning / low | warning / low | yes |
| `render.canonical-changed` | JavaScript: Canonical Mismatch | issue / high | issue / high | yes |
| `render.h1-changed` | JavaScript: H1 Updated by JavaScript | warning / medium | warning / medium | yes |
| `render.meta-description-changed` | JavaScript: Meta Description Updated by JavaScript | warning / medium | warning / medium | yes |
| `render.noindex-changed` | JavaScript: Noindex Only in Original HTML | issue / medium | issue / high | **no** |
| `render.title-changed` | JavaScript: Page Title Updated by JavaScript | warning / medium | warning / medium | yes |
| `resources.bad-content-type` | Security: Bad Content Type | warning / low | warning / low | yes |
| `resources.uncached` | PageSpeed: Use Efficient Cache Lifetimes | opportunity / medium | opportunity / medium | yes |
| `robots.blocks-internal-urls` | Response Codes: Internal Blocked by Robots.txt | warning / high | warning / high | yes |
| `schema.none-on-site` | Structured Data: Missing | opportunity / low | opportunity / low | yes |
| `schema.product-incomplete` | Structured Data: Rich Result Validation Errors | issue / high | issue / high | yes |
| `security.form-insecure` | Security: Form URL Insecure | issue / high | issue / high | yes |
| `security.headers-missing` | Security: Missing Content-Security-Policy Header | warning / low | warning / low | yes |
| `security.hsts-missing` | Security: Missing HSTS Header | warning / low | warning / low | yes |
| `security.http-url` | Security: HTTP URLs | issue / high | issue / high | yes |
| `security.mixed-content` | Security: Mixed Content | issue / high | issue / high | yes |
| `sitemap.non-200` | Sitemaps: Non-Indexable URLs in Sitemap | issue / medium | issue / medium | yes |
| `sitemap.non-indexable` | Sitemaps: Non-Indexable URLs in Sitemap | issue / medium | issue / medium | yes |
| `sitemap.over-50k-urls` | Sitemaps: XML Sitemap with over 50k URLs | issue / high | issue / high | yes |
| `sitemap.oversized` | Sitemaps: XML Sitemap over 50MB | issue / high | issue / high | yes |
| `sitemap.redirected` | Sitemaps: Non-Indexable URLs in Sitemap | issue / medium | issue / medium | yes |
| `sitemap.url-in-multiple` | Sitemaps: URLs in Multiple Sitemaps | warning / low | warning / low | yes |
| `social.image-broken` | Social: Non-200 OG Image URL | issue / low | issue / low | yes |
| `social.og-duplicate` | Social: Duplicate OG Title | warning / low | warning / low | yes |
| `social.og-incomplete` | Social: Missing OG Tags | opportunity / low | opportunity / low | yes |
| `social.og-multiple` | Social: Multiple OG Tags | warning / low | warning / low | yes |
| `social.og-url-mismatch` | Social: Non-Canonical OG URL | warning / low | warning / low | yes |
| `social.x-incomplete` | Social: Missing X Cards | opportunity / low | opportunity / low | yes |
| `structure.deep-page` | Links: Pages With High Crawl Depth | opportunity / medium | opportunity / medium | yes |
| `title.duplicate` | Page Titles: Duplicate | opportunity / medium | opportunity / medium | yes |
| `title.missing` | Page Titles: Missing | issue / high | issue / high | yes |
| `title.multiple` | Page Titles: Multiple | issue / high | issue / high | yes |
| `title.pixel-too-long` | Page Titles: Over 561 Pixels | opportunity / medium | opportunity / medium | yes |
| `title.pixel-too-short` | Page Titles: Below 200 Pixels | opportunity / medium | opportunity / medium | yes |
| `title.same-as-h1` | Page Titles: Same as H1 | opportunity / low | opportunity / low | yes |
| `title.too-long` | Page Titles: Over 60 Characters | opportunity / medium | opportunity / medium | yes |
| `title.too-short` | Page Titles: Below 30 Characters | opportunity / medium | opportunity / medium | yes |
| `url.internal-search` | URL: Internal Search | warning / low | warning / high | **no** |
| `url.multiple-slashes` | URL: Multiple Slashes | issue / low | issue / low | yes |
| `url.non-ascii` | URL: Non ASCII Characters | warning / low | warning / low | yes |
| `url.parameter-pages-indexable` | URL: Parameters | warning / low | warning / high | **no** |
| `url.repetitive-path` | URL: Repetitive Path | warning / low | warning / low | yes |
| `url.spaces` | URL: Contains Space | issue / low | issue / low | yes |
| `url.too-long` | URL: Over 115 Characters | opportunity / low | opportunity / low | yes |
| `url.tracking-params-internal` | URL: GA Tracking Parameters | warning / low | warning / low | yes |
| `url.underscores` | URL: Underscores | opportunity / low | opportunity / low | yes |
| `url.uppercase` | URL: Uppercase | warning / low | warning / low | yes |

**The 12 divergences, each with its reason** (the `// differs from SF:` comment on the
row in `triage.ts`):

| rule | SF | ours | why |
|---|---|---|---|
| `content.csr-dependent` | warning / medium | warning / **high** | Ours fires only when rendering at least doubles the page's words, so the main content depends on rendering, which is an indexing question. SF's issue lists any content JavaScript adds. |
| `directives.unavailable-after` | warning / medium | warning / **high** | Ours fires only on a date already past, within 30 days, or unreadable: the cases where the page is about to leave the index, or stays when its author expected it to leave. SF lists every `unavailable_after`. |
| `head.tags-outside-head` | issue / high | issue / **medium** | One rule covers the title, the meta description and the social tags (SF: high, medium and low across three issues). What is lost is how the page appears in results and when shared, not whether it is indexed. |
| `html.head-closed-early` | warning / high | **issue** / high | Ours fires only when head tags follow the early close and are read as body content, so a canonical, robots directive or title is lost: a defect. SF lists every invalid element in the head. |
| `html.head-closed-early-harmless` | warning / high | warning / **low** | The same early close with no head tag after it, so nothing is lost today: a latent hazard, not a page served wrongly. |
| `http.no-response-transient` | issue / high | **warning** / high | The URL answered on the end-of-crawl re-check, so the failure was intermittent and may not recur; a human checks it. (`http.no-response`, still failing on re-check, agrees with SF.) |
| `http.server-error-transient` | issue / high | **warning** / high | The 5xx cleared on re-check, so the failure was intermittent; a human checks it. (`http.server-error` agrees with SF.) |
| `images.empty-alt` | issue / low | **warning** / low | An empty alt is correct on a decorative image and wrong on one that carries meaning, and the rule (as its copy says) cannot tell the two apart, so a human checks it. |
| `nav.js-only` | warning / medium | warning / **high** | Ours fires only when the site's navigation (nav and footer links) exists only after rendering, so a crawler reading the response finds almost no way onward: a crawling question. SF's issue lists any JavaScript link. |
| `render.noindex-changed` | issue / medium | issue / **high** | Ours reports both directions (noindex removed by JavaScript, or added by it), and either decides whether the page is indexed, depending on which reading a search engine acts on. |
| `url.internal-search` | warning / low | warning / **high** | Ours lists only internal search pages that are INDEXABLE, which is a question of what gets indexed. SF lists every internal search URL. |
| `url.parameter-pages-indexable` | warning / low | warning / **high** | Ours lists only parameter URLs that return 200, carry no noindex and canonicalise to themselves, the ones that enter the index beside their parameter-free page. SF lists every parameter URL. |

Task 1's review moved one row the other way: `html.structure-invalid` had been
`warning / medium` against SF's `issue / high` with no semantic difference, and now
takes SF's value. Its review left four mapping calls for the owner to confirm, listed
in §7: the two `url.*` rows above (SF low, ours high), the mixed-scope mappings, and
`performance.slow-response` left unmapped.

**The 42 unmapped rows**, assigned from the rubric:
- the 16 NOT MEASURED markers, all `warning / low` by construction:
  `content.near-duplicate-skipped`, `content.thin-skipped`, `crawl.blocked`,
  `crawl.unreadable-encoding`, `extraction.not-recorded`, `h1.duplicate-skipped`,
  `host.probe-skipped`, `hreflang.alternates-not-crawled`,
  `hreflang.declarations-incomplete`, `links.orphan-skipped`, `resources.all-unknown`,
  `resources.not-fetched`, `resources.not-recorded`, `resources.partial-unknown`,
  `robots.check-skipped`, `security.headers-not-recorded`;
- 26 rules with no SF counterpart: `canonical.chain` issue/high,
  `canonical.cross-domain` warning/high, `directive.canonical-noindex-conflict`
  issue/high, `directives.bot-conflict` warning/high, `host.duplicate-host-200`
  issue/high, `host.legacy-host-reachable` issue/high, `hreflang.source-conflict`
  issue/high, `indexability.meta-header-conflict` issue/high, `links.aria-label-only`
  warning/low, `links.empty-href` issue/low, `pagination.next-target-uncrawled`
  warning/low, `performance.slow-response` warning/medium, `resources.broken`
  issue/high, `robots.blocks-sitemap-urls` issue/high, `robots.missing`
  opportunity/low, `schema.breadcrumb-absent` opportunity/low,
  `schema.self-serving-reviews` warning/low, `sitemap.cross-host-loc` issue/medium,
  `sitemap.invalid` issue/high, `sitemap.lastmod-invalid` issue/low,
  `sitemap.missing` opportunity/low, `sitemap.uncrawled` warning/low,
  `sitemap.url-too-long` issue/low, `social.image-insecure` warning/low,
  `url.normalisation-variants` issue/high, `url.reference-too-long` issue/low.

## 3. Clause 3: the Issues Overview against `issues_list`

**Re-judge, step (a).** `gate27a/abc.mts`, an MCP client over the SDK's in-memory
transport against the dev database, with an EMPTY allowlist so that every crawl trigger
is refused by policy. The crawl before the gate (read with `psql`): `finished`, 600
pages, `rules_run_at` 2026-11-08 01:04:43, `judgement_jsonb` null, stamp
`{"thresholds": {}, "disabledRules": []}`, 3,202 findings over 46 rules.

```
crawl_rules {crawlId: crawl_4dd32709-56c9-4a62-9af4-7a843f76ff6c}
→ {pagesScanned: 602, findings: 3202, metrics: 92, … } in 9.2 s
crawl_status → rulesRunAt 2026-11-08T19:56:26Z, judgementStale {stale: false, reasons: []},
               findingsCount 3202, pagesScanned 602
```

The 0.23.0 run wrote the same 3,202 findings over the same 46 rules, every rule's count
as the stored run had it. (The script ran twice, re-judging each time. In the first run every check passed
except the two on the discovery section, where the script's own filter took the
`sitemap` row of `discovered_via` for the in-sitemap split. The second run, with that
filter fixed, is the one recorded.)

**Reconciliation, step (b).** For each `issues_overview` row the script paged
`issue_urls` for that rule to a null cursor and counted distinct `evidence.pageUrl`
values, a finding with none counting as one site-wide entry: the key `urls` is defined
on (Ruling 9). It also put `issues_list`'s `count` beside it and recomputed
`percentOfJudged` from `pagesJudged` (446, `site.health`'s Pages Judged).

`issues_overview` → `rulesetVersion 0.23.0, pagesJudged 446, 46 rows, disabledRules [],
judgementStale {stale: false}`; `issues_list` walked to the end → 46 groups,
`disabledRules []`. Same 46 rule ids. Rows in the documented order (type, priority,
`urls` descending, rule id): checked.

| rule | type / priority | `urls` | distinct URLs in `issue_urls` | site-wide entry | `issues_list.count` | `percentOfJudged` | agrees |
|---|---|---:|---:|---|---:|---:|---|
| `hreflang.non-indexable-target` | issue / high | 4 | 4 | — | 4 | 0.9 | yes |
| `security.http-url` | issue / high | 2 | 2 | — | 2 | 0.4 | yes |
| `links.broken-internal` | issue / high | 1 | 1 | — | 1 | 0.2 | yes |
| `headings.h1-missing` | issue / medium | 18 | 18 | — | 18 | 4 | yes |
| `pages.not-in-sitemap` | issue / medium | 4 | 4 | — | 4 | 0.9 | yes |
| `sitemap.non-200` | issue / medium | 1 | 1 | — | 1 | 0.2 | yes |
| `images.missing-alt` | issue / low | 270 | 270 | — | 270 | 60.5 | yes |
| `canonical.points-elsewhere` | warning / high | 54 | 54 | — | 54 | 12.1 | yes |
| `indexability.nofollow` | warning / high | 4 | 4 | — | 4 | 0.9 | yes |
| `indexability.noindex` | warning / high | 4 | 4 | — | 4 | 0.9 | yes |
| `robots.blocks-internal-urls` | warning / high | 2 | 2 | — | 2 | 0.4 | yes |
| `url.internal-search` | warning / high | 2 | 2 | — | 2 | 0.4 | yes |
| `content.placeholder` | warning / high | 1 | 1 | — | 1 | 0.2 | yes |
| `links.only-from-non-indexable` | warning / high | 1 | 1 | — | 1 | 0.2 | yes |
| `links.uncrawlable` | warning / high | 1 | 1 | — | 1 | 0.2 | yes |
| `content.near-duplicate` | warning / medium | 96 | 96 | — | 96 | 21.5 | yes |
| `headings.h1-multiple` | warning / medium | 28 | 28 | — | 28 | 6.3 | yes |
| `images.empty-alt` | warning / low | 446 | 446 | — | 446 | 100 | yes |
| `links.unsafe-target-blank` | warning / low | 257 | 257 | — | 257 | 57.6 | yes |
| `h2.missing` | warning / low | 234 | 234 | — | 234 | 52.5 | yes |
| `security.headers-missing` | warning / low | 200 | 200 | — | 200 | 44.8 | yes |
| `pagination.next-target-uncrawled` | warning / low | 34 | 34 | — | 34 | 7.6 | yes |
| `headings.level-skip` | warning / low | 11 | 11 | — | 11 | 2.5 | yes |
| `social.og-duplicate` | warning / low | 3 | 3 | — | 3 | 0.7 | yes |
| `links.high-outlinks` | warning / low | 2 | 2 | — | 2 | 0.4 | yes |
| `redirect.js` | warning / low | 2 | 2 | — | 2 | 0.4 | yes |
| `extraction.not-recorded` | warning / low | 1 | 1 | yes | 1 | 0.2 | yes |
| `hreflang.alternates-not-crawled` | warning / low | 1 | 1 | yes | 1 | 0.2 | yes |
| `links.orphan-skipped` | warning / low | 1 | 1 | yes | 1 | 0.2 | yes |
| `resources.not-fetched` | warning / low | 1 | 1 | yes | 1 | 0.2 | yes |
| `title.too-short` | opportunity / medium | 157 | 157 | — | 157 | 35.2 | yes |
| `title.pixel-too-short` | opportunity / medium | 115 | 115 | — | 115 | 25.8 | yes |
| `content.thin` | opportunity / medium | 64 | 64 | — | 64 | 14.3 | yes |
| `title.pixel-too-long` | opportunity / medium | 17 | 17 | — | 17 | 3.8 | yes |
| `title.too-long` | opportunity / medium | 8 | 8 | — | 8 | 1.8 | yes |
| `structure.deep-page` | opportunity / medium | 6 | 6 | — | 6 | 1.3 | yes |
| `title.duplicate` | opportunity / medium | 1 | 1 | — | 1 | 0.2 | yes |
| `title.same-as-h1` | opportunity / low | 338 | 338 | — | 338 | 75.8 | yes |
| `meta-description.too-long` | opportunity / low | 312 | 312 | — | 312 | 70 | yes |
| `meta-description.pixel-too-long` | opportunity / low | 291 | 291 | — | 291 | 65.2 | yes |
| `images.missing-dimensions` | opportunity / low | 118 | 118 | — | 118 | 26.5 | yes |
| `meta-description.missing` | opportunity / low | 78 | 78 | — | 78 | 17.5 | yes |
| `links.non-descriptive-anchor` | opportunity / low | 5 | 5 | — | 5 | 1.1 | yes |
| `meta-description.duplicate` | opportunity / low | 2 | 2 | — | 2 | 0.4 | yes |
| `meta-description.pixel-too-short` | opportunity / low | 2 | 2 | — | 2 | 0.4 | yes |
| `meta-description.too-short` | opportunity / low | 2 | 2 | — | 2 | 0.4 | yes |

- **46 of 46 agree**: `urls` equals the distinct URL count of `issue_urls`, and
  `percentOfJudged` equals `urls / 446` to one decimal.
- `issues_list.count` (a FINDING count, Ruling 9) equals `urls` for every rule on this
  crawl too: no rule here fires more than once per URL. The counts sum to 3,202,
  `crawl_status.findingsCount`.
- **Site-wide rules**, whose one finding names no URL and counts as one entry:
  `extraction.not-recorded`, `hreflang.alternates-not-crawled`, `links.orphan-skipped`
  and `resources.not-fetched`. All four are markers, and all four are rows.
- `includeZero: true` → 174 rows, 128 of them `urls: 0`: every enabled finding rule.

**The route.** `gate27a/http-equality.mts` served the dev database from a live HTTP
server on 127.0.0.1 (ephemeral port) and compared four answers with the MCP tool's,
whole: `GET /crawls/:id/overview/issues` (with and without `?includeZero=true`),
`GET /crawls/:id/overview/crawl` and `GET /crawls/:id/config`. **All four equal**, all
200. `GET …/overview/issues` has no route test in the suite (§7), so this is its
cross-transport evidence.

## 4. Clause 4: the Crawl Overview against `crawl_status`

Same script, step (c). The `urls` entries are reconciled one by one with the
`crawl_status` field each is defined from (Ruling 10), not summed:

| entry | `crawl_overview` | `crawl_status` | field |
|---|---:|---:|---|
| Encountered | 602 | 602 | `frontier.pending + leased + done + failed + renderPending` (0 + 0 + 600 + 0 + 0) + `robotsBlocked.recorded` (2) |
| Fetched | 600 | 600 | `pagesCrawled` |
| Not fetched (frontier) | 0 | 0 | `frontier.pending + leased` |
| Blocked by robots.txt (stored) | 2 | 2 | `robotsBlocked.recorded` |
| Blocked by robots.txt (dropped) | 0 (percent `null`) | 0 | `robotsBlocked.dropped` |

The other sections were checked as partitions, which is what they are by definition:
`fetch-class`, `status-class`, `indexability`, `click-depth`, `discovery` (per
`discovered_via`, and separately the in-sitemap split) and `response-time` (without its
`Over SLOW_MS` line) **each sum to 602**, `crawl_status.pagesScanned`. The `issues-grid`
sums to **3,202**, `findingsCount`. `notMeasured` is empty: the crawl was judged and
rendered (21 pages, `Render coverage (ran)`).

The answer, by section: `fetch-class` ok 504, redirect 93, client_error 2, disallowed 2,
non_html 1; `status-class` 2xx 505, 3xx 93, 4xx 2, 5xx 0, No response 2;
`indexability` Indexable 446, Redirected 93, Canonicalised 54, Noindex 4, Blocked by
robots.txt 2, Client Error 2, Not HTML 1; `click-depth` 1 / 77 / 254 / 153 / 7 / 6 / 4 / 2
at depths 0–7, none deeper, Unreachable 98; `discovery` sitemap 443, link 158, seed 1,
In a sitemap 444, Not in a sitemap 158; `response-time` Under 250 ms 444, 250–500 ms 150,
500–1000 ms 6, slower 0, No response time 2, Over SLOW_MS (1500 ms) 0; `issues-grid`
issue/high 7, issue/medium 23, issue/low 270, warning/high 69, warning/medium 124,
warning/low 1,193, opportunity/high 0, opportunity/medium 368, opportunity/low 1,148.
Indexable 446 equals `site.health`'s Pages Judged, the Issues Overview's `pagesJudged`.

On the dev database's unjudged crawl from before migration 0020 (`crawl_a696e51a…`),
`crawl_overview` answered seven sections and named `click-depth`, `issues-grid`,
`render` and `robots-blocked-dropped` in `notMeasured`, and `issues_overview` refused
the crawl: "has not been judged: run crawl_rules first — an empty overview would read
as a clean site" (`gate27a/shapes.log`).

## 5. Clause 5: the override round trip

`gate27a/defg.mts`, all over the MCP surface, from the crawl as step (a) left it. 25
checks, **25 pass** (`gate27a/defg.log`).

**(d) Read-time overrides.** One `crawl_config_set`:
`{rules: {"title.same-as-h1": {disabled: true}, "images.empty-alt": {type: "issue"},
"meta-description.too-long": {priority: "medium"}}}` (338, 446 and 312 findings).
No rules run follows. Each surface, immediately:

| surface | disabled `title.same-as-h1` | retyped `images.empty-alt` | reprioritised `meta-description.too-long` | `judgementStale` |
|---|---|---|---|---|
| `crawl_config_set`'s answer | in the block | in the block | in the block | `{stale: true, reasons: ["overrides"]}` |
| `issues_list` | group gone; `disabledRules: ["title.same-as-h1"]` | `type: "issue"`, `typeOverridden: true`, count 446 | `priority: "medium"`, `priorityOverridden: true`, count 312 | `["overrides"]` |
| `issues_overview` | row gone (45 rows); `disabledRules` names it | `type: "issue"`, `typeOverridden: true` | `priority: "medium"`, `priorityOverridden: true` | `["overrides"]` |
| `rules_catalog` (crawlId) | still listed, `disabled: true`, `fired.count` 338 | `type: "issue"`, `typeOverridden: true` | `priority: "medium"`, `priorityOverridden: true` | `["overrides"]` |
| `issues` CSV (`export_crawl`) | no rows (2,864 rows = 3,202 − 338) | 446 rows, every `type` cell `issue` | 312 rows, every `priority` cell `medium` | — |
| `issue_urls` | refused: "rule 'title.same-as-h1' is disabled on crawl '…'; re-enable it with crawl_config_set to list its findings" (CONFLICT, 409 over HTTP) | | | — |
| `crawl_overview` issues grid | sums to 2,864 | its 446 moved from warning/low to issue/low | its 312 moved from opportunity/low to opportunity/medium | — |
| `crawl_status`, `metrics_get` | `findingsCount` still 3,202 (stored rows) | | | `["overrides"]` |

**(e) Threshold round trip.** `crawl_config_set {thresholds: {SLOW_MS: 500}}` (default
1500; six pages are over 500 ms) → `thresholds.SLOW_MS {value: 500, default: 1500,
overridden: true}`, `judgementStale {stale: true, reasons: ["overrides", "thresholds"]}`.
- **Before the re-run:** every `issues_list` count exactly as in (d);
  `performance.slow-response` 0 (`rules_catalog` `fired.count` 0); its title still
  "Performance: Response time over 1500 ms" and the catalog's `thresholds.SLOW_MS`
  1500 (the stamp); reasons include `thresholds`.
- `crawl_rules` → 3,206 findings in 9.2 s, `performance.slow-response` 4.
- **After:** `performance.slow-response` **0 → 4** (the four indexable, self-canonical
  pages over 500 ms, at 620, 597, 578 and 538 ms, each with `threshold: 500` in its
  evidence); title and explanation "…over 500 ms" in `rules_catalog` and the
  `issues_overview` row; `judgedWith {disabledRules: ["title.same-as-h1"], thresholds:
  {SLOW_MS: 500}}` (the stamp then held overrides only; see the re-run below);
  `judgementStale {stale: false, reasons: []}` on `crawl_config_get`
  and `issues_list`; `crawl_overview`'s line reads `Over SLOW_MS (500 ms)`: 6 (all
  pages, so more than the rule's 4, as documented); the disabled rule still out.
- **Re-run after the final review (Ruling 15: the stamp holds the 20 effective
  thresholds).** On the same crawl, after migration 0033 and on the final code
  (`gate27a/stamp.mts`, `gate27a/stamp.log`, 12 of 12 checks): the stamp 0033 left
  was `{disabledRules: [], thresholds: {TITLE_MIN: 30, TITLE_MAX: 60, META_MIN: 70,
  META_MAX: 155, H1_MAX: 70, H2_MAX: 70, URL_MAX: 115, SLOW_MS: 1500, TITLE_PX_MIN:
  200, TITLE_PX_MAX: 561, META_PX_MIN: 400, META_PX_MAX: 985, DEEP_DEPTH: 5,
  THIN_WORDS: 150, SOFT_404_WORDS: 300, IMAGE_WEIGHT_WARN: 100000, CHAIN_HOPS: 2,
  HIGH_INTERNAL_OUTLINKS: 1000, HIGH_EXTERNAL_OUTLINKS: 10,
  UNAVAILABLE_AFTER_WARN_DAYS: 30}}`. `crawl_config_set {thresholds: {SLOW_MS: 500}}`
  → stale `["thresholds"]`, title still "…over 1500 ms"; `crawl_rules` → 3,206
  findings in 9.2 s, `performance.slow-response` **0 → 4**; **the stamp then held all
  20 keys, `SLOW_MS: 500` and the other 19 at their defaults**; title and explanation
  "…over 500 ms" in `rules_catalog` and the `issues_overview` row, the catalog's
  `thresholds.SLOW_MS` 500, `Over SLOW_MS (500 ms)`: 6, nothing stale. Cleanup:
  `{thresholds: null}` and a re-run → 3,202 findings, every rule's count as before,
  `judgedWith {disabledRules: [], thresholds: <the 20 defaults>}`, not stale.

**(f) Re-enable.** `crawl_config_set {rules: {"title.same-as-h1": null}}`, no run →
`issues_list` has the group back at **338**, `issue_urls` lists 338 rows,
`disabledRules: []`. `judgementStale` is `{stale: true, reasons: ["overrides"]}`: the
last run stamped the rule as disabled, so `site.health` still left it out
(Review Focus 2).

**(g) Cleanup.** `crawl_config_set {rules: null, thresholds: null}` → `judgement: {}`,
stale `["overrides", "thresholds"]`; `crawl_rules` → 3,202 findings. Final
`crawl_config_get`: `judgement {}`, `judgedWith {disabledRules: [], thresholds: {}}`
(overrides only, before the final review; after 0033 and the re-run above it holds
the 20 defaults), `judgementStale {stale: false}`, `SLOW_MS` 1500 not overridden. **Every rule's
`issues_list` count equals the step (a) baseline**, and `findingsCount` is 3,202. In
the database (`psql`, `gate27a/final-state.txt`): `finished`, `judgement_jsonb` `{}`,
stamp `{"thresholds": {}, "disabledRules": []}`, `config_jsonb` with no `findingCap`,
3,202 findings over 46 rules. The one difference from the crawl as found:
`judgement_jsonb` reads `{}` where it was `NULL`. Both mean "no overrides", and `{}` is
what `crawl_config_set` stores for an empty block.

**Refusals, same session, nothing written** (`gate27a/shapes.log`; the block read `{}`
after all five):
- `{rules: {"title.too-long": {severity: "critical"}}}` → `rules.title.too-long.severity:
  severity cannot be overridden: …`;
- `{thresholds: {TITLE_MIN: 70}}` → `thresholds.TITLE_MIN: thresholds.TITLE_MIN (70)
  must be strictly below thresholds.TITLE_MAX (60, the default)` (Review Focus 4);
- `{thresholds: {SLOW_MS: 99}}` → `thresholds.SLOW_MS: Too small: expected number to be
  >=100`;
- `{rules: {"site.health": {disabled: true}}}` → `… is a metric rule; it produces no
  findings, so it cannot be disabled, retyped or reprioritised`;
- `{rules: {"no.such-rule": …}}` → `rules.no.such-rule: no rule 'no.such-rule' in
  ruleset`.

## 6. Deviations from the spec, and the rulings a surface reader sees

The plan's six deviations, unchanged by the build:

1. **`findingCap` stays stored in `config_jsonb.findingCap`.** The block exposes it as
   `judgement.findingCap`, and get and set read and write that one location.
   `crawl_start`'s top-level `findingCap` is unchanged; given both ways with different
   values, the start is refused.
2. **Three migrations, `0031`–`0033`, where the spec named one.** The backfill is
   data and has its own custom migration (`0032`), and the final review's
   effective-value stamp rewrote the stamps already written (`0033`, also data:
   0031 and 0032 were already applied, so they were not edited). 27b's
   `control_request` column becomes `0034`.
3. **`issue_urls` and `issue_inlinks` refuse a disabled rule** (409, "rule X is
   disabled on this crawl"), where the spec says the findings "disappear". A refusal
   cannot be mistaken for "fired on nothing".
4. **`crawl_config_get` / `crawl_config_set` arrive in 27a, limited to `judgement`.**
   27b widens them to crawl fields and adds the schema tools; names and routes stay.
5. **Crawl Overview response-time buckets are fixed** (under 250 ms, 250–500,
   500–1000, 1000–2000, 2000+), with a separate `Over SLOW_MS` line on the stamped
   `SLOW_MS`. The spec's "1000–`SLOW_MS`" bucket breaks when `SLOW_MS` is under 1000.
6. **`crawl_compare` reads stored findings, unfiltered,** and gains the caveat code
   `judgement-overrides` when either side disables rules. It does not change
   `comparable`.

Two more, recorded by the final review:

7. **The stamp now holds the effective thresholds, as the spec says** ("stamps the
   effective thresholds it used"). The build first stamped the overrides alone and
   rebuilt the values from today's defaults; a later ruleset that moved a default would
   then have rendered copy against stored evidence with the wrong number and missed the
   staleness. The stamp's `thresholds` is now all 20 at the values the run used;
   `readStamp` refuses one missing a key or holding an out-of-range value, naming the
   crawl; the copy reads the stamp directly; staleness compares effective values on
   both sides. Migration 0033 rewrote the existing stamps (Ruling 15). This is a
   deviation from the build, not from the spec.
8. **The stamp's column is `crawls.rules_judged_with_jsonb`,** where the spec names
   `rules_thresholds_jsonb`. It holds the disabled set and the cap beside the
   thresholds, and the name says so.

The rulings made during the build that change what a surface reader sees, each
documented in `docs/talos-surface.md`:

- **Ruling 5: 20 overridable thresholds, not 19.** The plan's table and the spec name
  20; "exactly these 19" was a miscount. `crawl_config_get` lists all 20.
- **Ruling 7: `findingCap: null` in `crawl_config_set` means uncapped**, as at
  `crawl_start`, and is not RFC 7396's "remove the key". Removal would silently restore
  the cap of 200 on a billed audit. Send `200` for the default.
- **Ruling 8: the Crawl Overview's Canonicalised reason uses the SQL rules' canonical
  predicate**, which abstains (counts the page Indexable) on a relative, non-ASCII or
  dot-segment canonical. The overview agrees with what the rules judge.
- **Ruling 9: `issues_overview`'s `urls` is the distinct URL count `issue_urls` lists
  for the rule**, a finding with no URL counting as one site-wide entry. The spec
  (the Issues Overview section: "distinct pages with a finding; site-level findings
  count 1") and its gate clause ("Issues Overview counts equal `issues_list` counts")
  are superseded on this point, and the spec text is not edited: the page-id definition
  reports 1 for a site-wide rule listing 200 uncrawled sitemap URLs, and
  `issues_list.count` counts findings, which can exceed URLs (a rule that fires twice
  on a page). Clause 3 is measured against the restated definition, with
  `issues_list.count` beside it.
- **Ruling 10: the Crawl Overview's `urls` section is built from `crawl_status`'s own
  fields** (Encountered = the frontier total plus the stored robots-blocked rows;
  Fetched = `pagesCrawled`; Not fetched = pending + leased; Blocked stored and dropped).
  The entries are not asserted to sum, because a resume reseeds `pagesCrawled`; the
  dropped count's percent is null. Clause 4 reconciles each entry with its field.
- **Ruling 11: response-time labels** `Under 250 ms`, `250–500 ms`, `500–1000 ms`,
  `1000–2000 ms`, `2000+ ms`, each `[lo, hi)`, and `Over SLOW_MS (<n> ms)` with `>`,
  as `performance.slow-response` uses.
- **Ruling 12: the render section** is measured when a render pass ran: `Pages
  rendered` live, and `Render coverage (<state>)` from the stored `render.coverage`
  metric. On a rendered, unjudged crawl that entry is named in `notMeasured` as
  `render-coverage`; on a judged crawl a missing or malformed metric row throws.
- **Ruling 13: content labels** are prefixed `HTML: <page type>`, `Non-HTML: <family>`
  and `Resource: <kind>`, each percent against its own group's subtotal; `too_large`
  and `unsupported_encoding` pages are in neither page group.
- **Ruling 14: both overviews read the judgement inside their own repeatable-read
  snapshot**, so a concurrent `crawl_rules` cannot make an overview report measured
  zeros or a mix of two runs.
- **Ruling 15 (final review): the stamp holds the 20 effective thresholds** (Deviation
  7 above); `judgedWith.thresholds` on `crawl_config_get` lists all 20.
- **Ruling 16 (final review): `H1_MAX` 1–299, `H2_MAX` 1–299, `URL_MAX` 20–2499**,
  each strictly below the extraction cap on what it measures (§7).

Rulings 1–4 and 6 are internal (task ordering, the threshold guard's form, error
discrimination, a citation fix) and change nothing a reader sees, beyond Ruling 4's
effect that a stored override of a removed rule is a 409 naming the rule.

## 7. Follow-ups and concerns for the owner

- **Owner calls left by Task 1's review (triage values):** `url.internal-search` and
  `url.parameter-pages-indexable` moved from SF's low to high (§2: ours list only the
  indexable cases); the mixed-scope mappings that take the milder SF issue
  (`pagination.non-indexable-target`, `social.og-incomplete`, `social.x-incomplete`);
  `schema.self-serving-reviews` at warning/low where the rubric could say medium;
  `performance.slow-response` left unmapped though SF's "PageSpeed: Document Request
  Latency" is a counterpart. Each is one line in `triage.ts` and an override per crawl
  meanwhile.
- **`GET /crawls/:id/overview/issues` has no route test.** The gate compared it live
  (§3); a pair in the transport-equality test would pin it.
- **Fixed after the gate: the `pg` deprecation warning from the Crawl Overview.** The
  gate's live run printed "Calling client.query() when the client is already executing
  a query is deprecated and will be removed in pg@9.0" on every `crawl_overview` call,
  the CSV included. `crawlDetailOn` ran `crawl_status`'s six detail reads in a
  `Promise.all`, and inside the overview's snapshot transaction they all landed on one
  client, which `pg` 8 queues and `pg` 9 will not. The reads now run one after another
  on a transaction and stay parallel on the pool, so `crawl_status` is unchanged. A test
  in `test/api/crawl-overview.test.ts` ("never issues a query while another is in
  flight on its client, and emits no warning") watches the client directly, because
  Node prints that deprecation only once per process. It failed with 20 overlapping
  queries against the old code and passes now. Re-run after the fix: `test/api`
  10 files / 483 tests green with no warning in the output, `tsc` clean, and the four
  live route-versus-tool comparisons (§3) still equal, with no warning printed.
- **Fixed in the final review: three threshold maxima sat at an extraction cap.**
  `H1_MAX` / `H2_MAX` accepted 300, the cap on stored heading text
  (`MAX_H1_TEXT_CHARS`, `H2_TEXT_MAX`), and `URL_MAX` accepted 2500, the cap on a
  stored URL (`INDEXED_URL_MAX`), so an override at the max left the rule unable to
  fire (hard rule 1). The ranges are now `H1_MAX` 1–299, `H2_MAX` 1–299 and
  `URL_MAX` 20–2499; `test/rules/threshold-table.test.ts` imports each cap and pins
  `max < cap`.
- **The stored crawl's `judgement_jsonb` is `{}` where it was `NULL`** (§5 (g)); the
  same meaning.
- The deferred minors from the task reviews are triaged in the SDD ledger; each is
  "can wait".

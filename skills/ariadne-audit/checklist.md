<!--
PROVENANCE — this file was imported, not authored here.

  Source        ~/.claude/skills/sf-audit/checklist.md
  Source sha256 7a4ca768166d9566cec4827812aaae4045e862e855c9329f54eea611b04f17e8
  Imported      2026-08-27 (Ariadne Phase 6, P6-T4)
  Origin        internal: the checklist is the owner's own work, carried into the
                repository it now belongs to. Not a third-party lift, so it has no
                entry in THIRD_PARTY_NOTICES.md.

WHAT CHANGED AT IMPORT — only where a check's "how" changed owner:

  1. Every `- **CLI**:` line (a Screaming Frog export command) became a
     `- **Engine**:` line naming the Ariadne tool call and the rule or metric ids
     that answer the check. Where the engine answers a check outright, its
     `**Requires**` tag says `Engine`.
  2. CHECK-01, CHECK-02 and CHECK-34 lost their JS-disabled DevTools recipes:
     the render pass answers them now, and the agent quotes `issues_list` /
     `metrics_get` instead of re-running the experiment in a browser.
  3. The tooling preamble (Execution Tiers, How to Use, Browser Tools), the
     Master Export Command and the Crawl Configuration Requirements were
     rewritten for the engine — SF's three CLI calls and its GUI settings are
     `crawl_start` fields and `export_crawl` datasets now.
  4. Two evaluation principles were re-pointed at engine output, and a fourth was
     added: never re-judge a claimed check by eyeball.

WHAT DID NOT CHANGE, and must not: every CHECK id, every check's title, priority,
`**Evaluate**` criteria and `**Record**` list. The rule registry's `checkIds`
trace to the ids in this file and CI asserts the coverage.

THE SOURCE IS FROZEN. This was a one-time import, not a sync target: this file is
the living authority (CLAUDE.md hard rule 10). Fix a check HERE; never edit the
source and re-import.
-->

# SEO & GEO Audit Checklist — Agent Instructions

Master checklist for running a technical SEO & GEO audit. Each item has:
- **Engine**: the Ariadne tool call(s) that answer the check, and the rule or metric ids behind them
- **DevTools**: browser checks — JS execution, network, console, Lighthouse, DOM extraction
- **Visual**: browser checks — visual page assessment, layout, UX, content quality
- **GSC / GA4 / Ahrefs MCP**: analytics and authority queries
- **Evaluate**: Pass/Fail criteria and what to record
- **Requires**: Data sources needed (see Execution Tiers below)

The engine produces facts — findings, measured metrics, crawled pages — and no
judgement at all. The verdict on a check, its severity in this site's context and
the narrative around it are the agent's, and they are built by quoting engine
output rather than by re-deriving it.

## Execution Tiers — CRITICAL RULES

The **Requires** tag on each check lists data sources. These have strict execution expectations:

| Tier | Source | Expectation |
|------|--------|-------------|
| **Always execute** | Engine | Call the tool named in the check and quote what it answers |
| **Always execute** | DevTools | Run the JS in a browser on the pages the check names |
| **Always execute** | Visual | Navigate pages, take screenshots, assess visually |
| **Always execute** | GSC | Query via GSC MCP server |
| **Always execute** | GA4 | Query via GA4 MCP server |
| **Always execute** | Ahrefs MCP | Query via the Ahrefs MCP server |
| **Flag for human** | Manual | Only after completing ALL automatable steps above |

An **Engine** check is not a check you may skip because a browser was easier to
reach: the engine has already crawled the whole site, and a browser has seen one
page. The engine's answer is the site-wide one.

### Gate Rule

**You MUST attempt all DevTools and Visual steps defined in the checklist for a check
BEFORE marking anything as MANUAL.** The "Manual" tag means the *final subjective
verdict* may need human review — it does NOT mean you skip the automatable parts.

For example, CHECK-41 (E-E-A-T) requires `Visual + DevTools + Manual`:
- You MUST navigate to the About page, blog articles, and content pages (Visual)
- You MUST extract internal links and topic clustering data (DevTools)
- You MUST record concrete observations about what you found
- Only the final "is this E-E-A-T sufficient?" judgment is flagged for human review

### Status Definitions

| Status | Meaning |
|--------|---------|
| **PASS** | Check passed based on data and criteria |
| **FAIL** | Check failed — issue found with evidence |
| **WARN** | Potential issue — needs attention but not critical |
| **N/A** | Check not applicable to this site |
| **SKIP** | Tool not available or data not accessible (e.g., the Ahrefs MCP server is not connected) |
| **MANUAL** | Claude completed all automatable steps and recorded findings. Only the final subjective assessment needs human review. Must include what was found. |

**MANUAL is NOT the same as SKIP.** MANUAL means you did the work and recorded findings.
SKIP means you couldn't do the work. Never use MANUAL as an excuse to skip DevTools/Visual steps.

**How these land in the findings file.** The audit writes one machine-readable
record per check (see `SKILL.md`, Phase 4), whose `verdict` field carries four
values, so the six statuses above map onto them without losing anything:

| Status here | `verdict` | `severity` |
|-------------|-----------|------------|
| PASS | `PASS` | `null` |
| FAIL | `FAIL` | `critical` or `warning` — the engine's severity for the rule, or yours in context |
| WARN | `FAIL` | `warning` or `info` |
| N/A | `SKIP` | `null`, with `notes` saying why the check does not apply |
| SKIP | `SKIP` | `null`, with `notes` naming what was unavailable |
| MANUAL | `AGENT` | your severity, with `notes` carrying what you found |

## Evaluation Principles — NON-NEGOTIABLE

These apply to every check, every time. They are not overridden by CMS defaults, common
patterns, or assumptions about client intent.

### 1. Never assume intent. Evaluate on SEO merit only.
A configuration is not correct because it looks deliberate. A configuration is not correct
because it is a common Shopify/WordPress/Magento default. Ask one question only:
**Does this help or hurt organic performance?**

Examples of assumptions that are WRONG:
- "Blog index pages are noindexed — this is a common Shopify pattern, so it's probably fine" → WRONG
- "These pages are canonicalised — probably intentional" → WRONG
- "GA tracking parameters on internal links — likely set up by their marketing team" → WRONG

The correct approach: state what you found, state the SEO impact, state the fix. Do not
qualify findings with "this may be intentional" or "confirm with the client". If it has
a negative SEO impact, it is a finding regardless of intent.

### 2. Never answer a check from a crawl summary. Use the source the check names.
`crawl_status` reports how big the crawl was — pages crawled, frontier counts, whether
the render pass ran. Those numbers describe the crawl, not the site's SEO, and they are
filtered differently from every per-check query. A check names its own tool call and its
own filter; use that one.

Example: `crawl_status.pagesCrawled` is every URL the crawler fetched, including the
non-indexable, the redirects and the 404s. `pages_query` with `indexable: true` is a
different, smaller number. CHECK-31's depth distribution is a third. All three are
correct and only one answers each check.

### 3. Check what URLs actually are before drawing conclusions.
URL type detection on path segments alone causes false positives. Always check:
- Does `/cdn/shop/products/image.jpg` mean a product page? No — it is a CDN asset.
- Does `/collections/dresses/products/slug` mean a unique product? No — it is a
  Shopify collection-scoped duplicate of `/products/slug`.
- Does a large orphan count mean missing products? Maybe — but classify URL types
  first before reporting. The engine's own `pageType` cohorts (visible on
  `pages_query`, and the `scopeValue` of every page-type-scoped metric) are the
  crawl's template detection, not a path guess — prefer them, and say so when a
  cohort you care about lands in `(untyped)`.

### 4. Never re-judge a claimed check by eyeball.
If a check's **Engine** line names a rule or a metric, the engine has already
looked at every page on the site for it. Quote what it answers — the counts, the
sample URLs, the metric's value — and reach a verdict from that. Do not open one
page in a browser and grade the check on what that page showed: one page is not a
site, and a hand check that disagrees with the engine is a bug report about the
rule, not a finding about the client.

The inverse is equally binding. An empty listing from a crawl nobody judged is
NOT a clean site: `issues_list` and `metrics_get` answer `{"items": []}` both when
a rule found nothing and when `crawl_rules` never ran. Nothing on `crawl_status`
says which — `rulesetVersion` is stamped when the crawl is accepted, not when it
is judged — so the only proof is the `crawl_rules` summary. Run it yourself (it
is idempotent: a second run re-judges the same crawl with the current ruleset)
and keep its `{pagesScanned, findings, byRule, byMetric}` as the audit's evidence
that every empty answer afterwards means "nothing found".

## Analytics Tools (MCP Servers)

Three MCP servers provide live API access to analytics and authority data. They are the
operator's to configure; the audit does not install them. If one is missing, say so and
mark its checks SKIP with the server named — never quietly substitute a guess.

1. **GSC MCP** (`gsc` server — 20 tools)
   - Search analytics: queries, pages, clicks, impressions, CTR, position
   - URL inspection: indexing status, crawl info, rich results
   - Sitemaps: submission status, coverage
   - Compare periods for trend analysis
   - Filter by country, device, search type, query, page

2. **GA4 MCP** (`ga4` server — 7 tools)
   - `run_report`: full GA4 reporting with dimensions, metrics, filters, pagination
   - `run_realtime_report`: live traffic data
   - `get_account_summaries`: list all properties to find the right one
   - `get_property_details`: property configuration
   - Use `sessionDefaultChannelGroup` dimension to segment by organic source
   - Use `sessionSource` / `sessionMedium` for granular source breakdown

3. **Ahrefs MCP** (namespace `mcp__a0369373-5739-4331-b4c9-ddad7f6442c0` — many tools)
   - Site Explorer: domain rating, referring domains, backlink stats, broken backlinks, anchor text
   - Brand Radar: AI citations, cited pages, share of voice, impressions, mentions
   - If this server is not connected, mark CHECK-79, CHECK-80, and CHECK-81 as SKIP

**Important**: At the start of the audit, use `list_properties` (GSC) and
`get_account_summaries` (GA4) to identify the correct property IDs for the domain
being audited. Store these for use throughout the checks.

## Browser Tools

The engine has no browser of its own except the render pass, which re-fetches a
budgeted sample of pages and stores what JavaScript added. Everything a browser is
still needed for — Lighthouse and Core Web Vitals, console and network errors,
mobile viewport behaviour, the look of a page, and the judgement checks — is the
agent's, and it needs a real browser driven by whichever browser MCP server the
operator has connected.

What a browser check needs from that server:

- navigate to a URL
- execute JavaScript on the loaded page (DOM extraction, schema parsing, link counting)
- read the page's text
- take a screenshot
- resize the viewport (mobile checks)

**Before the first browser check**, confirm the server answers. If it does not:

1. Do NOT mark the browser checks SKIP yet, and do NOT substitute a plain HTTP
   fetch for a check that needs a rendered page — a fetch has no JavaScript, no
   console and no layout, and a check answered from one is answered wrongly.
2. Tell the user which server is missing and what it blocks (name the checks).
3. Wait. If the user says to continue without it, mark exactly those checks SKIP
   with `notes` naming the missing tool.

Checks marked **DevTools** mean "execute the JavaScript below on the pages named,
in a real browser". Checks marked **Visual** mean "navigate, screenshot, and
assess what a person would see".

## How to Use

1. Crawl the site (see the `ariadne-crawl` skill), run the render pass, then run the rules
2. Walk the checks below in order; for each **Engine** line, call the tool it names and quote the answer
3. Run the DevTools checks in a browser for what the crawl cannot see
4. Run the Visual checks for UX and content quality assessment
5. Record a verdict + evidence for every check, including the ones that passed
6. Output: the findings file (`SKILL.md`, Phase 4), which the report and action-plan skills read

---

## Pre-Crawl Checks

These three were browser experiments run before the crawl, because nothing else
could answer them. **The engine's render pass answers them now**: it re-fetches a
budgeted sample of the crawl's pages in a real browser and stores what JavaScript
added, and three rules compare the two sides across the whole sample rather than
across the two pages a person had time to open.

They are therefore run AFTER the crawl, like every other engine check — and their
answers still inform crawl configuration, for the next crawl of this site (a site
that fails CHECK-01 needs a larger `renderBudgetPct`, and its link graph should be
read as provisional).

Their evidence exists only if the render pass ran. Confirm `crawl_status`
reports `renderPassCount` ≥ 1 before reading any of the three; if it is 0, these
checks are SKIP with `notes: "no render pass"`, not PASS.

### CHECK-01: Website rendering with JS disabled
- **Priority**: Critical | **Requires**: Engine (render pass)
- **Important**: Even if the site uses SSR (Server-Side Rendering), the question is what
  a crawler that does not run JavaScript can see. Some crawlers (including Googlebot in
  certain modes) crawl with JS disabled. Content and links must be accessible either way.
- **CRITICAL — the content that only exists after rendering**: the most damaging case on
  an e-commerce site is a collection page whose **product links** are absent from the raw
  HTML. Navigation and headings often pass an SSR eyeball test while the product grid is
  100% client-side, and the site then has no product discoverability without JS.
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-01"` — the rule is `content.csr-dependent`
     (critical). It fires on a rendered page whose rendered word count is at least
     twice its raw word count AND at least 150 words larger, which is the
     "most of what this page says arrived with the JavaScript" claim.
  2. `issue_urls` with `ruleId: "content.csr-dependent"` for the page list. Each
     row's evidence carries `{rawWordCount, renderedWordCount, addedWords}` — quote
     these, per page type, in place of the old JS-on/JS-off counts.
  3. `metrics_get` with `metricId: "render.coverage"` for the denominator: how many
     pages were rendered out of how many crawled, the selection budget, and the
     render failures. A finding count means nothing without it.
  4. `pages_query` with `rendered: true` to see which pages the sample covered, and
     which page types are represented. If a page type you care about was not
     sampled, say so rather than generalising from the ones that were.
  5. The nav side of the same question is CHECK-34 (`nav.js-only`) and the facet
     side is CHECK-02 (`filters.js-only`). Read all three together before you
     conclude anything about crawlability without JS.
- **Evaluate**:
  - Do NOT assume SSR means everything is fine — read the raw-vs-rendered numbers
  - PASS if the render diff found no CSR-dependent pages and no JS-only navigation, across a sample that covered every page type
  - WARN if navigation or key content is JS-dependent on some page types
  - FAIL if a page is essentially blank without JS (critical JS dependency: `addedWords` is most of `renderedWordCount`)
  - **FAIL if collection pages' product links are absent from raw HTML** — a crawler that does not render will miss most products, and Googlebot's initial crawl pass won't discover product URLs from collection pages. Products become entirely dependent on sitemap.xml for discovery. (Cross-read CHECK-33b: sitemap-only products are the same failure seen from the link graph.)
  - Record: raw vs rendered word counts per page type (from the finding evidence), **the nav and filter link counts from CHECK-34 and CHECK-02**, render coverage (rendered / crawled, and the failures), recommendation for the next crawl's `renderBudgetPct`

### CHECK-02: Filters / layered navigation — HTML or JS elements?
- **Priority**: High | **Requires**: Engine (render pass)
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-02"` — the rule is `filters.js-only`
     (warning). It fires on a rendered page whose raw HTML offered the crawler no
     filter, facet or sort link at all while the rendered DOM exposed several.
     The raw side is zero by construction, so the claim is categorical: every URL
     behind those facets is invisible to a crawler that does not run JavaScript.
  2. `issue_urls` with `ruleId: "filters.js-only"` — each row's evidence is
     `{rawFilterLinks: 0, renderedFilterLinks: N}`. Group the URLs by page type to
     see whether this is one template or the whole collection surface.
  3. For the other half of the question — filters that ARE crawlable, and the URL
     volume they create — read CHECK-27 and CHECK-29: `metrics_get` with
     `metricId: "url.param-volumes"` is the parameter census, and it counts what
     the crawl actually reached rather than what a page's controls suggest.
  4. Whether the filtered URLs are handled once they exist (canonical, noindex,
     robots) is CHECK-27, CHECK-29 and CHECK-03; do not answer it here.
- **Evaluate**:
  - PASS if filters are HTML links with proper canonical/noindex handling
  - WARN if filters are JS-only (hidden from crawlers — the facet URLs will not be discovered without rendering)
  - WARN if filters generate many crawlable URL variants (combinatorial explosion risk — inform CHECK-29 and CHECK-31)
  - Record: filter implementation type (HTML links / JS-only / hybrid) per page type, URL pattern generated, estimated URL volume, recommendation for the next crawl's include/exclude posture

---

## 0. Organic Performance Overview

Run this section FIRST — before any technical checks. It establishes the performance
baseline and context that informs priority decisions throughout the rest of the audit.
A site losing 40% organic traffic has very different priorities than one growing steadily.

**Prerequisites**: GSC and GA4 MCP servers must be connected. Use `list_properties` (GSC)
and `get_account_summaries` (GA4) to identify the correct property IDs for the domain.

### CHECK-71: Organic traffic overview — all sources, segmented by performance
- **Priority**: Critical | **Requires**: GA4
- **GA4 MCP**: Run these reports for the property:
  1. **Overall organic**: `run_report` with:
     - Dimensions: `sessionDefaultChannelGroup`
     - Metrics: `sessions`, `totalUsers`, `engagedSessions`, `engagementRate`, `averageSessionDuration`, `screenPageViewsPerSession`, `bounceRate`
     - Date range: last 90 days
     - Filter: `sessionDefaultChannelGroup` == "Organic Search"
  2. **Organic by source**: Same report but add dimension `sessionSource` to break down by Google, Bing, Yahoo, DuckDuckGo, other
  3. **Period comparison**: Run same report for prior 90 days and calculate % change
  4. **Monthly trend**: Run with dimension `yearMonth` + `sessionDefaultChannelGroup` filtered to organic, for last 12 months
- **Evaluate**:
  - Identify traffic direction: growing, stable, declining
  - Flag any source with >20% decline
  - Note which organic sources drive meaningful traffic vs negligible
  - Record: total organic sessions, users, engagement rate per source, trend direction, % change period-over-period

### CHECK-72: Brand vs non-brand performance
- **Priority**: Critical | **Requires**: GSC
- **GSC MCP**: Use `get_search_analytics` with:
  1. **Brand queries**: Filter queries containing brand name (and common misspellings)
     - `get_search_analytics(property, start_date, end_date, dimensions=["query"], row_limit=500)`
     - Post-process: split results into brand (contains brand term) vs non-brand
  2. **Period comparison**: `compare_search_periods` for brand vs non-brand splits
  3. **Brand by page**: `get_advanced_search_analytics` with dimensions `["query", "page"]` filtered to brand queries — which pages capture brand traffic?
- **Evaluate**:
  - Calculate brand vs non-brand ratio (healthy: non-brand > 60%)
  - Flag if brand traffic declining (reputation/awareness issue)
  - Flag if non-brand traffic declining (SEO visibility issue)
  - Identify brand queries going to wrong pages (homepage vs product)
  - Record: brand clicks/impressions/CTR/position, non-brand same, ratio, trend direction for both

### CHECK-73: Top pages by organic performance
- **Priority**: Critical | **Requires**: GSC + GA4
- **GSC MCP**: `get_search_analytics` with:
  - Dimensions: `["page"]`
  - Metrics: clicks, impressions, CTR, position
  - Row limit: 100 (top 100 pages)
  - Date range: last 90 days
- **GA4 MCP**: `run_report` with:
  - Dimensions: `landingPage`, `sessionDefaultChannelGroup`
  - Metrics: `sessions`, `engagementRate`, `conversions` (if available), `averageSessionDuration`
  - Filter: organic channel
- **Cross-reference**: Match GSC top pages with GA4 engagement data
- **Evaluate**:
  - Identify pages with high impressions but low CTR (title/description optimization opportunity)
  - Identify pages with high traffic but low engagement (content quality issue)
  - Identify pages with good engagement but low traffic (promotion/linking opportunity)
  - Flag any top page that has technical issues in the crawl data (4xx, redirect, noindex)
  - Record: top 20 pages table with clicks, impressions, CTR, position, sessions, engagement rate

### CHECK-74: Query landscape & ranking distribution
- **Priority**: High | **Requires**: GSC
- **GSC MCP**: `get_search_analytics` with:
  - Dimensions: `["query"]`
  - Row limit: 500
  - Date range: last 90 days
- **Analysis**:
  1. **Position buckets**: Group queries into 1-3, 4-10, 11-20, 21-50, 51+
  2. **Opportunity queries**: Position 4-20 with high impressions (striking distance)
  3. **Defending queries**: Position 1-3 — are these stable? Use `compare_search_periods`
  4. **Query intent mapping**: Categorise top queries as navigational, informational, transactional, commercial
  5. **Query gaps**: Cross-reference with page types — are there page types with no query coverage?
- **Evaluate**:
  - Healthy distribution: significant queries in positions 1-10
  - Flag if most queries are 20+ (low authority/relevance signals)
  - Identify top 10 striking-distance opportunities (position 4-15, high impressions)
  - Record: distribution table, top 10 opportunities, defending queries, intent breakdown

### CHECK-75: Conversions and events from organic
- **Priority**: High | **Requires**: GA4
- **GA4 MCP**: `run_report` with:
  1. **Conversion overview**:
     - Dimensions: `sessionDefaultChannelGroup`
     - Metrics: `conversions`, `purchaseRevenue` (if ecommerce), `ecommercePurchases`, `addToCarts`
     - Filter: organic channel
     - Date range: last 90 days
  2. **Conversion by landing page** (if conversions exist):
     - Dimensions: `landingPage`, `sessionDefaultChannelGroup`
     - Metrics: `conversions`, `sessions`, `engagementRate`
     - Filter: organic channel
  3. **Key events** (if no conversions configured):
     - Dimensions: `eventName`, `sessionDefaultChannelGroup`
     - Metrics: `eventCount`
     - Filter: organic channel
     - Look for: `purchase`, `add_to_cart`, `begin_checkout`, `sign_up`, `generate_lead`, `form_submit`, `file_download`, `scroll`, `click`
- **Evaluate**:
  - If conversions configured: calculate organic conversion rate vs site average
  - Flag if organic conversion rate is significantly below other channels
  - If no conversions: flag as a tracking gap — recommend setting up key events
  - Identify top converting landing pages — these are priority pages for technical health
  - Record: organic conversions, revenue (if applicable), conversion rate, top converting pages, key events list

### CHECK-76: AI & referral traffic from AI platforms
- **Priority**: High | **Requires**: GA4
- **GA4 MCP**: `run_report` with:
  1. **AI referral sources**:
     - Dimensions: `sessionSource`, `sessionMedium`
     - Metrics: `sessions`, `totalUsers`, `engagementRate`, `averageSessionDuration`, `conversions`
     - Filter: source contains any of: `chatgpt`, `openai`, `perplexity`, `claude`, `anthropic`, `gemini`, `copilot`, `bing` (copilot), `you.com`, `phind`, `kagi`
  2. **AI traffic trend**:
     - Same filter, add dimension `yearMonth`, date range last 6 months
  3. **AI landing pages**:
     - Dimensions: `landingPage`, `sessionSource`
     - Same AI source filter
     - Which pages are AI platforms sending users to?
- **Evaluate**:
  - Baseline: what % of total traffic comes from AI sources?
  - Trend: growing, stable, or nonexistent?
  - Which AI platforms send the most engaged traffic?
  - Which pages attract AI referrals? (these are "AI-visible" pages)
  - Record: AI traffic by source, trend, top landing pages, engagement comparison vs organic search

### CHECK-77: Indexation coverage — GSC vs crawl
- **Priority**: High | **Requires**: GSC + Engine
- **GSC MCP**:
  1. `get_performance_overview` — total indexed pages approximation from impression data
  2. `batch_url_inspection` — inspect 10 sample URLs across page types:
     - Homepage, 2-3 products, 1-2 collections, 1 blog post, 1 info page
     - Check: indexing state, crawl date, canonical, robots
  3. `check_indexing_issues` — if any sample URL shows issues, expand to more URLs
- **Cross-reference with the crawl**:
  - `pages_query` with `indexable: true` for the indexable page count (follow the
    cursors, or `export_crawl` with `dataset: "pages"` and count the rows)
  - Compare: total indexable pages from the crawl vs pages with impressions in GSC
  - Large gap = indexation problem (pages crawled but not indexed)
  - Pages whose indexability the crawl never settled come back `indexable: null` and
    match NEITHER filter — count them separately rather than folding them into either side
- **Evaluate**:
  - FAIL if key page types not indexed
  - WARN if >20% of indexable pages have zero impressions (potential indexation gap)
  - Record: indexed page count (GSC), indexable page count (crawl), gap %, sample URL inspection results

### CHECK-78: Keyword cannibalisation (data-driven)
- **Priority**: High | **Requires**: GSC
- **GSC MCP**: `get_advanced_search_analytics` with:
  - Dimensions: `["query", "page"]`
  - Row limit: 500
  - Date range: last 90 days
- **Analysis**:
  1. Group by query — find queries with 2+ ranking pages
  2. For each cannibalising query: compare CTR and position of competing pages
  3. Flag where the "wrong" page ranks higher (e.g., blog post outranking product page for transactional query)
  4. Check if competing pages have proper canonicals (CHECK-16/CHECK-17 findings)
- **Evaluate**:
  - WARN if >10 cannibalising query groups found
  - FAIL if cannibalisation affects high-volume queries (>100 impressions)
  - Record: cannibalising query count, top 10 by impact (impressions), competing URL pairs, recommended winner

---

## 1. Crawlability & Robots

### CHECK-03: robots.txt — reachable, valid, not over-blocking
- **Priority**: Critical | **Requires**: Engine + DevTools
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-03"`. Three rules can answer:
     - `robots.missing` (info) — the site answered 4xx for /robots.txt. The crawl
       treated that as allow-all, which is correct and is still worth reporting.
     - `robots.blocks-sitemap-urls` (warning) — URLs the site's own sitemap
       publishes and its own robots.txt forbids. `issue_urls` gives the list.
     - `robots.check-skipped` (info) — the stored robots.txt could not be re-parsed
       (too large to read, or never served). This is a NOT MEASURED marker: the
       robots questions below are unanswered on this crawl, not answered clean.
  2. `issues_list` with `checkId: "CHECK-05"` (`crawl.blocked`) for pages the crawl
     was refused — a robots-shaped block that shows up as a fetch outcome.
- **DevTools** (the parts no crawl answers — the file's *contents*, and the gaps in it):
  1. Navigate to `{domain}/robots.txt` — extract full content
  2. Parse: User-agent blocks, Disallow rules, Sitemap lines, Crawl-delay
  3. Check for AI bot rules: GPTBot, ChatGPT-User, Google-Extended, ClaudeBot, Anthropic-AI, PerplexityBot, CCBot
  4. Flag any Disallow rules blocking important content paths (/collections/, /products/, /blogs/)
  5. **Pattern gap analysis** (MANDATORY): Don't just read the rules — test specific URL
     patterns against them to find gaps. Construct these test URLs and check each:
     - Single filter: `/collections/{name}?filter.v.size=UK+10` — blocked?
     - Filter + pagination: `/collections/{name}?filter.v.size=UK+10&page=2` — blocked?
     - Pagination only: `/collections/{name}?page=2` — blocked?
     - Single tag: `/blogs/{name}/tagged/{tag}` — blocked?
     - Tag + pagination: `/blogs/{name}/tagged/{tag}?page=2` — blocked?
     - Sort + pagination: `/collections/{name}?sort_by=price&page=2` — blocked?
     Present results as a table showing each test URL pattern and whether it's blocked or passes through.
  6. **Shopify-specific**: The default Shopify robots.txt blocks `*/collections/*filter*&*filter*`
     (two+ filters) but NOT single filter URLs. It blocks `*sort_by*` but doesn't block
     `?page=` pagination. Check if these gaps exist and flag the crawl surface they create.
- **Evaluate**:
  - FAIL if robots.txt returns non-200
  - FAIL if key content paths are blocked
  - WARN if no Sitemap: line declared
  - WARN if single filter URLs or filter+pagination combinations pass through robots.txt rules
  - Record: blocked paths list, AI bot rules, sitemap declaration, blocked URL count from the engine, **pattern gap analysis table**

### CHECK-04: Meta robots & X-Robots-Tag directives
- **Priority**: Critical | **Requires**: Engine
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-04"`. Two rules:
     - `indexability.noindex` (info) — every page the crawl found excluded from the
       index, whether by meta tag or by header.
     - `indexability.meta-header-conflict` (warning) — a page whose robots meta and
       `X-Robots-Tag` header disagree. That is a directive the site cannot predict
       the outcome of, and it is a finding on its own.
  2. `issue_urls` with `ruleId: "indexability.noindex"` for the FULL list — this is
     the export the check's Record line asks for, one row per URL, each carrying
     `{source: "meta" | "header", robotsMeta, xRobotsTag}`. Follow the cursors: the
     list is the point, and a first page of 50 is not it.
  3. `pages_query` with `indexable: false` to see the same pages beside their type,
     status and depth — which is how you tell a deliberately excluded cart page from
     a noindexed blog index.
  This covers every page type the crawl reached, so there is no sampling to do and
  no browser to open.
- **Important — Don't just count noindexed pages, CHECK WHAT THEY ARE**: A report of
  "6 pages noindex — appropriate" is useless if you haven't verified what those 6 pages
  are. The blog index being noindexed is a critical issue but gets lost in a "6 pages"
  count. For every noindexed page, explicitly state the URL and whether the noindex is
  correct or incorrect.
- **Common Shopify mistakes to check**:
  - Blog index (`/blogs/journal`) noindexed — prevents discovery of articles
  - Paginated blog pages noindexed — prevents discovery of older articles
  - Collection pages with filters noindexed (may be intentional, but verify)
  - Policy pages noindexed (shipping, returns — these have organic value)
- **Evaluate**:
  - PASS if noindex/nofollow only on truly intended pages (account, cart, checkout, search internal)
  - **FAIL if blog index or blog paginated pages are noindexed** — this blocks article discovery
  - FAIL if important indexable pages have noindex
  - Record: noindex count, nofollow count, **full list of noindexed URLs with assessment
    of whether each is correct or incorrect**

### CHECK-05: Geo/IP redirects and bot blockers
- **Priority**: Critical | **Requires**: Engine + DevTools + Manual
- **Engine**: `issues_list` with `checkId: "CHECK-05"` — `crawl.blocked` (warning)
  reports pages the crawler was refused rather than served (the fetch was classified
  `blocked`; the evidence carries the status code). A branded, politely paced crawler
  being blocked is a bot-blocker finding, and `issue_urls` gives the affected URLs.
  Report it against the user agent the crawl actually used — the claim is "this UA
  was blocked on these URLs", never "all bots are blocked".
- **DevTools** (geo behaviour, which needs a browser and a location):
  1. Navigate to homepage — note any redirect chain (final URL, status codes)
  2. Navigate to a product page — same check
  3. Check response headers for Vary: Accept-Language or geo-detection headers
  4. If Shopify Markets or multi-regional: test /en/, /es/, /fr/ prefixes directly
- **Evaluate**:
  - PASS if no forced geo-redirects detected
  - WARN if geo-detection headers present
  - Note: Full geo-testing requires VPN/proxy — flag for manual follow-up if geo logic detected
  - Record: redirect behavior, geo-detection headers

---

## 2. Sitemaps

### CHECK-06: Sitemap exists, in robots.txt, valid format
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-06"`. Two rules:
  - `sitemap.missing` (warning) — the crawl found no sitemap to read: robots.txt
    declared none and the conventional locations answered nothing.
  - `sitemap.invalid` (warning) — a declared sitemap document was fetched and could
    not be read as a sitemap (the commonest real case is a 200 that is HTML). It is
    ONE site-scoped finding, so `sampleUrls` is empty and `count` is 1 however many
    documents failed: read it with `issue_urls` on `ruleId: "sitemap.invalid"`, where
    `url` is null and the evidence carries `failures` (up to 50 documents) and
    `failureCount` (the true number).
  The sitemap's shape — index vs flat, how many child documents, how many entries
  each — is CHECK-08's metric; do not re-fetch the file to describe it.
- **Evaluate**:
  - FAIL if sitemap returns non-200 or robots.txt has no Sitemap: line
  - WARN if flat sitemap with >50k URLs
  - Record: sitemap type, child sitemap count, total URLs, robots.txt Sitemap line status

### CHECK-07: Sitemap contains only indexable 200 URLs
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-07"` — four rules, and each is one
  of the reasons the Record line asks you to break the count down by:
  - `sitemap.non-200` (warning) — a listed URL that did not answer 200
  - `sitemap.redirected` (warning) — a listed URL that redirects
  - `sitemap.non-indexable` (warning) — a listed URL the crawl judged non-indexable
  - `sitemap.uncrawled` (info) — a listed URL this crawl never reached (blocked by
    robots, or outside the crawl's budget). NOT MEASURED, not clean.
  `issue_urls` per rule for the URL lists; `metrics_get` with
  `metricId: "sitemap.structure"` gives `totalUrls` for the denominator.
- **Evaluate**:
  - FAIL if non-indexable URLs > 0
  - Severity = non-indexable count / total sitemap URLs
  - Record: count, breakdown by reason (noindex, 3xx, 4xx, canonicalised)

### CHECK-08: Sitemap structure (large sites)
- **Priority**: Medium | **Requires**: Engine (metric)
- **Engine**: `metrics_get` with `metricId: "sitemap.structure"`. This check is
  MEASURED, not found: no rule fires for it, so `issues_list` with
  `checkId: "CHECK-08"` is refused with a pointer here rather than answered empty.
  - the `site` row: `{docs, totalUrls, urlCapBreaches, entryCapReached, oversizedDocsSkipped}`
  - one `sitemap_doc` row per document (`scopeValue` is the document's URL) with
    `{urls, breaches50k}` — the largest 50 are listed
  - `entryCapReached: true` means every count here is a FLOOR, not a total: say so
    rather than quoting the numbers flat
- **Evaluate**:
  - PASS if sitemaps split logically by type (products, collections, blog, pages)
  - WARN if single flat sitemap on site >5k URLs
  - Record: sitemap structure description

### CHECK-09: URLs not found in sitemaps
- **Priority**: High | **Requires**: Engine
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-09"` — `pages.not-in-sitemap` (info) is
     every indexable page the crawl found that the sitemap does not list.
     `issue_urls` for the list.
  2. `issues_list` with `checkId: "CHECK-32"` for the orphan count (`links.orphan`)
     — the other half of the same picture, and a different question: not in the
     sitemap vs not reachable by a link.
- **Evaluate**:
  - WARN if indexable pages not in sitemap > 5% of total
  - Record: missing URL count, orphan URL count, top page types missing

---

## 3. Redirects & Errors

### CHECK-10: Redirect chains, loops, JS redirects, and redirect volume
- **Priority**: Critical | **Requires**: Engine
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-10"` — three finding rules:
     - `redirect.chain` (warning) — a redirect that lands on another redirect
     - `redirect.loop` (critical) — a redirect that returns to a URL already in its chain
     - `redirect.js` (warning) — a redirect performed by JavaScript rather than by a
       3xx, found by the render pass (so it needs `renderPassCount` ≥ 1 to be measured)
     `issue_urls` per rule for the hops and the URLs.
  2. `metrics_get` with `metricId: "redirect.volume"` — the site row carries
     `{redirectPages, totalPages, ratioPct, chains, loops}`: how much of what the
     crawl fetched was a redirect, plus the exact chain and loop counts.
     `redirectPages` counts one row per redirecting URL, so a template link that
     redirects on every page of the site is ONE redirect page here.
  3. **What the engine does NOT measure: total redirect INLINKS.** The
     crawl-budget number the Analysis below asks for is a link-graph question and
     no rule claims it today. Report it as NOT MEASURED in the findings notes —
     never substitute `ratioPct` for it, which is a different ratio (redirecting
     URLs ÷ URLs fetched) and will understate a repeated template redirect by
     exactly the factor that makes it worth reporting.
- **Important — Total Redirect Volume Analysis**: Do NOT just count unique redirect URLs.
  A site can have only 31 unique redirect URLs but 550K+ total redirect inlinks if the same
  redirecting link is repeated across thousands of pages (e.g., a template element like a
  returns widget or footer link that redirects on every page). The **total redirect inlink
  count** is what impacts crawl budget, not the unique URL count.
- **Analysis**:
  1. Unique redirect URLs: `redirect.volume`'s `redirectPages`, with `ratioPct` as
     its share of the crawl
  2. **Total redirect inlinks**: NOT MEASURED by the engine (see the Engine note
     above). Record the gap; if the client needs the number, it is a link-graph
     export, not something to estimate from what is here
  3. If a redirect appears as an inlink from most page types, a template-level
     redirect exists — the redirect findings' URLs, grouped by `pageType`, are the
     evidence available for that claim today
  4. Identify the top redirect destinations from the `redirect.chain` evidence (each
     finding carries its hops), and say how many URLs share a destination
  5. For the top offender(s): open one source page in a browser and find where the link
     lives in the template. Common culprits: returns/refund widgets, footer links, promo
     banners, policy links. (The engine names the link; naming the *template element* is
     browser work.)
  6. Crawl budget waste: state it as redirecting URLs ÷ URLs crawled (`ratioPct`) and
     label it as such. Flag if >10%. The inlink-weighted version stays unmeasured.
- **Evaluate**:
  - FAIL if redirect chains > 0
  - CRITICAL if redirect loops found
  - WARN if JS redirects found
  - **FAIL if total redirect inlinks exceed 10% of total URLs crawled** — this indicates
    a systemic crawl budget waste from repeated redirecting links in page templates
  - Record: unique redirect URL count, **total redirect inlink count**, top redirect
    destinations by inlink volume, top anchor texts, source template identification,
    crawl budget waste %, chain count, loop count, JS redirect count, longest chain hops

### CHECK-11: Broken internal links (4xx)
- **Priority**: Critical | **Requires**: Engine + DevTools
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-11"` — `links.broken-internal` (warning):
     an internal link whose target answered 4xx.
  2. `issue_urls` with `ruleId: "links.broken-internal"` — the developer's list.
     Each row's evidence names the broken target and where the link was found, which
     is what the action plan hands over. Follow the cursors, or `export_crawl` with
     `dataset: "issues"` if the count is in the thousands.
  3. `pages_query` with `statusCode: 404` for the 4xx URLs themselves, beside their
     page type — a 404 nothing links to is a different problem from a linked one.
- **DevTools**: Spot-check 2-3 source pages to verify broken links in context
- **Evaluate**:
  - FAIL if 4xx > 0
  - Group by: broken page links vs broken image/asset links
  - Record: total broken URLs, source pages affected, breakdown by type (page, image, CSS), top affected source pages

### CHECK-12: 5xx server errors
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-12"` — `http.server-error`
  (critical), one finding per page whose fetch was classified a server error, with
  the status code in the evidence. `issue_urls` for the list. A 5xx during a crawl
  can also be a rate-limit symptom: check the crawl's pacing before reporting a
  site-wide outage (the engine paces itself, but a fragile host can still tip).
- **Evaluate**:
  - FAIL if internal 5xx > 0
  - Record: count, affected URLs, source pages

### CHECK-13: Soft-404s and thin OK responses
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-13"` — two rules:
  - `content.soft-404` (warning) — a 200 response whose text reads as a
    not-found page
  - `content.thin` (warning) — a 200 page with too little body text to serve any
    query (the same rule answers CHECK-40)
  `issue_urls` per rule; `pages_query` for the word counts beside page type, which
  is how the "% of indexable pages" in the Evaluate line is computed.
- **Evaluate**:
  - FAIL if soft 404s > 0
  - WARN if low content pages > 10% of indexable pages
  - Record: soft 404 count, low content count and percentage, sample URLs by page type

---

## 4. Host & Protocol

### CHECK-14: HTTP to HTTPS canonical route
- **Priority**: High | **Requires**: Engine (host probe)
- **Engine**: `issues_list` with `checkId: "CHECK-14"` — two rules:
  - `host.http-serves-200` (warning) — a plaintext spelling of the site answered 200
    instead of redirecting to https. One finding per spelling that did.
  - `host.probe-skipped` (info) — the crawl ran with `probeHosts: false`, so nothing
    about the host variants was measured. SKIP the check on that evidence; do not
    read the absence of the first rule as a pass.
  The probe is the only part of a crawl that fetches before robots.txt is read, so
  it runs once per crawl and answers CHECK-14 and CHECK-15 together.
- **Evaluate**:
  - FAIL if internal HTTP URLs exist or http:// doesn't redirect to https://
  - Record: HTTP URL count, redirect behavior

### CHECK-15: Primary host choice (www vs apex, legacy, staging)
- **Priority**: Medium | **Requires**: Engine (host probe)
- **Engine**: `issues_list` with `checkId: "CHECK-15"` — three rules:
  - `host.duplicate-host-200` (warning) — two spellings of the site (apex and www)
    both serve 200 over https, so the same content lives at two hosts
  - `host.legacy-host-reachable` (info) — a host passed as `legacyHosts` at
    `crawl_start` still serves content instead of redirecting to the live site
  - `host.probe-skipped` (info) — as above: nothing was probed
  **Legacy and staging hosts are only checked if you named them.** Pass them as
  `legacyHosts` when starting the crawl (each one must be on the operator's
  allowlist in its own right — they are different sites by every definition the
  engine has). A host nobody named is a host nobody probed, which is a SKIP, not a
  pass.
- **Evaluate**:
  - PASS if all variants redirect to one canonical host
  - FAIL if multiple hosts resolve to live content
  - Record: canonical host, redirect behavior per variant

---

## 5. Canonicals & Indexability

### CHECK-16: Self-referential canonicals on indexable pages
- **Priority**: Critical | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-16"` — `canonical.missing`
  (warning): an indexable page with no canonical at all. `issue_urls` for the list,
  and group it by `pageType` (via `pages_query`) to say whether one template is
  responsible. Pages that self-canonicalise produce no finding — that is the pass.
- **Evaluate**:
  - FAIL if indexable pages missing canonical > 0
  - Record: self-referencing count, missing count, missing URLs by page type

### CHECK-17: Canonicalised URLs audit
- **Priority**: Critical | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-17"` — `canonical.points-elsewhere`
  (info): every page whose canonical names a different URL. The engine reports the
  fact; whether each target is the RIGHT one is the judgement this check asks for,
  so read the list from `issue_urls` (source and target per row) and assess the
  patterns — do not report the count alone.
- **Evaluate**:
  - Review canonical targets — are they correct?
  - WARN if canonicalised count is high relative to total pages
  - FAIL if canonical targets are wrong
  - Record: canonicalised count, canonical target patterns, incorrect targets

### CHECK-18: Conflicting canonical signals
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-18"` — two rules:
  - `canonical.multiple` (warning) — more than one canonical on the page
  - `canonical.html-header-conflict` (warning) — the HTML canonical and the
    `Link: rel=canonical` header name different URLs
  `issue_urls` per rule; the evidence carries the competing targets.
- **Evaluate**:
  - FAIL if multiple conflicting canonicals > 0
  - Record: count, affected URLs, conflicting targets

### CHECK-19: Canonical to non-200 / non-indexable target
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-19"` — two rules:
  - `canonical.non-200-target` (warning) — the canonical points at a URL that did
    not answer 200
  - `canonical.non-indexable-target` (warning) — it points at a page the crawl
    judged non-indexable
  Both join the canonical to the target's own crawled row, so a target the crawl
  never fetched produces no finding: check `pages_query` for the target URLs before
  reading a clean answer as "every canonical target is healthy".
- **Evaluate**:
  - FAIL if canonical points to non-200 or non-indexable target
  - Record: count, affected URLs, target status codes

### CHECK-20: Cross-domain canonicals
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-20"` — `canonical.cross-domain`
  (info): a page whose canonical points at another host. No post-processing: the
  rule does the host comparison, including the apex/www spellings the crawl treats
  as one site.
- **Evaluate**:
  - WARN if found (verify intentional)
  - Record: count, source/target domain pairs

### CHECK-21: Directive conflicts (canonical + noindex)
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-21"` —
  `directive.canonical-noindex-conflict` (warning): a page that is both noindexed
  and canonicalised somewhere else. The cross-reference is the rule's; there are no
  two lists to intersect by hand.
- **Evaluate**:
  - FAIL if conflict found (sends mixed signals to search engines)
  - Record: count, affected URLs

---

## 6. Pagination

### CHECK-22: Pagination is HTML-based and crawlable
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-22"` — two rules:
  - `pagination.next-not-linked` (warning) — the page declares `rel="next"`, the
    target was crawled, and NO page on the site links to it. `rel="next"` has not
    been a discovery signal since 2019, so a series wired this way is one whose
    later pages nothing but the sitemap can find.
  - `pagination.next-target-uncrawled` (info) — the declared `rel="next"` target was
    never fetched by this crawl (or would not resolve). NOT MEASURED beyond that
    point, not "the sequence ends here".
  A JS-only "Load more" with no `rel="next"` at all leaves BOTH rules silent — the
  engine cannot report a declaration nobody made. That is what the DevTools steps
  below are for, and it is why this check keeps them.
- **DevTools** — Check BOTH collection and blog pagination separately:
  1. **Collection pagination**:
     - Navigate to a large collection (e.g., `/collections/all-dresses`)
     - Check the **raw HTML source** (fetch, not rendered DOM) for pagination links:
       `<a href="...?page=2">` or numbered page links
     - If only a "View More" / "Load More" button exists — check if it's a JS-only
       button or an actual `<a href>` link. If JS-only, pagination is not crawlable.
     - Check if numbered page links (1, 2, 3...) exist in HTML — these help crawlers
       discover all paginated pages in one level instead of sequential crawling
  2. **Blog pagination**:
     - Navigate to the blog index (`/blogs/{name}`)
     - Same checks: are `?page=2`, `?page=3` links in HTML?
     - Check meta robots on the blog index AND paginated pages (cross-ref CHECK-04)
  3. **Product grid on paginated pages**: Navigate to page 2 of a collection.
     Are product links rendered in HTML or JS-only? (cross-ref CHECK-01)
     If page 2 also has a JS-only product grid, even if the pagination link itself
     is crawlable, the products on that page won't be discovered.
- **Important**: Paginated pages (page 2, 3, etc.) should be **indexable** — do NOT
  recommend noindexing paginated content. The correct approach is indexed pages with
  self-referencing canonicals. Noindexing pagination removes those pages and their
  linked content from the index.
- **Evaluate**:
  - PASS if pagination links are HTML anchor tags and paginated pages are indexable
  - FAIL if JS-only (infinite scroll / "View More" button with no HTML link fallback)
  - FAIL if paginated pages are noindexed (this is incorrect — they should be indexed)
  - **FAIL if no HTML numbered page links exist** — numbered pagination (1, 2, 3...)
    is far better for crawl efficiency than just next/previous sequential links.
    It allows crawlers to reach page 10 in one hop instead of 9 sequential hops.
  - Record: pagination type per section (collection vs blog), HTML crawlable status,
    JS-only elements identified, numbered pages present or absent,
    indexability of paginated pages

### CHECK-23: Canonical strategy for paginated pages
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-23"` —
  `pagination.canonical-to-other` (info): a page 2+ (it declares `rel="prev"`) whose
  canonical points somewhere else, normally back to page 1. The engine states which
  strategy the site chose and leaves the verdict to you, which is exactly what this
  check asks for: a self-canonicalising paginated page fires nothing.
  Cross-read `issues_list` with `checkId: "CHECK-04"` for whether those same pages
  are noindexed — the two together are the "pagination is being hidden" finding.
- **DevTools** (rel=next/prev presence on a page the crawl typed, and the visible controls):
  1. Canonical tag — does it self-reference (`?page=2` canonicals to `?page=2`) or
     point back to page 1?
  2. Meta robots — is it indexed or noindexed?
  3. rel="next" / rel="prev" — are they present?
  
  Execute on a paginated page:
  ```javascript
  JSON.stringify({
    canonical: document.querySelector('link[rel="canonical"]')?.href,
    robots: document.querySelector('meta[name="robots"]')?.content,
    relNext: document.querySelector('link[rel="next"]')?.href,
    relPrev: document.querySelector('link[rel="prev"]')?.href,
    currentUrl: window.location.href
  })
  ```
- **Important**: The correct pagination setup is:
  - Each paginated page has a **self-referencing canonical** (page 2 canonicals to page 2)
  - Paginated pages are **indexed** (NOT noindexed)
  - rel="next" and rel="prev" help search engines understand the sequence
  - Noindexing pagination is wrong — it prevents discovery of content linked from those pages
  - Canonicalising page 2+ back to page 1 is wrong — it tells Google "only page 1 matters"
    and the products/articles on page 2+ won't be discovered via canonical signals
- **Evaluate**:
  - **FAIL if paginated pages canonical back to page 1** — this effectively tells search
    engines to ignore all paginated content, preventing discovery of products/articles
    beyond the first page
  - FAIL if paginated pages are noindexed
  - WARN if rel="next" / rel="prev" are missing
  - WARN if pagination sequence errors > 0
  - Record: canonical strategy per section (collection vs blog), self-referencing vs
    page-1 canonical, indexability status, rel next/prev presence, sequence error count

---

## 7. Hreflang

### CHECK-24: Complete hreflang sets with return links
- **Priority**: High | **Requires**: Engine
- **Engine**:
  1. `issues_list` with `checkId: "CHECK-24"` — `hreflang.missing-return-link`
     (warning): page A names B, and B does not name A back. One finding per broken
     pair; `issue_urls` carries both sides.
  2. `metrics_get` with `metricId: "hreflang.coverage"` — the coverage half of this
     check, which the Important note below demands and a finding list cannot give:
     `{pagesWithHreflang, indexablePages, coveragePct}` for the site and for each
     page type (`scope: "page_type"`, `scopeValue` the cohort). A page type at 0%
     coverage while its siblings are at 100% is the gap to report.
- **Important**: Don't just check for hreflang errors — also assess **coverage**:
  1. How many internal indexable URLs have hreflang tags vs how many should?
  2. If the site has multiple language/market versions, ALL equivalent pages should have hreflang
  3. Cross-reference: total indexable internal pages vs total pages with hreflang — identify the gap
  4. Flag page types missing hreflang that should have it (e.g., products exist in multiple markets but only some have hreflang)
- **Evaluate**:
  - FAIL if missing return links > 0
  - FAIL if significant coverage gap (many pages that should have hreflang don't)
  - WARN if hreflang only in sitemap (not in HTML)
  - Record: total hreflang URLs, total indexable URLs, coverage %, missing return links, page types without hreflang that should have it, implementation method (HTML/sitemap/both)

### CHECK-25: Language-region codes and x-default
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-25"` — two rules:
  - `hreflang.invalid-code` (warning) — a declared code that is not a valid
    language, or language-region, value
  - `hreflang.missing-x-default` (info) — a cluster with no `x-default` member
  `issue_urls` per rule for the affected URLs and the codes they declared.
- **Evaluate**:
  - FAIL if incorrect codes > 0
  - WARN if x-default or self-reference missing
  - Record: counts for each issue type

### CHECK-26: Hreflang to non-indexable or redirected URLs
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-26"` —
  `hreflang.non-indexable-target` (warning): an hreflang alternate that points at a
  page this crawl judged non-indexable (noindexed, canonicalised away, or not a 200).
  `issue_urls` gives the source/target pairs and the reason per row. A target the
  crawl never fetched cannot be judged and produces no finding — read it as
  unmeasured, not as sound.
- **Evaluate**:
  - FAIL if hreflang targets are non-200, noindexed, or non-canonical
  - Record: non-200 count, noindex count, non-canonical count, affected URL pairs

---

## 8. URL Parameters

### CHECK-27: Parameter audit and canonical handling
- **Priority**: High | **Requires**: Engine
- **Engine**:
  1. `metrics_get` with `metricId: "url.param-volumes"` — the parameter census:
     `{totalParams, trackingParams, topParams: [{name, occurrences, isTracking}],
     parameterisedPages, parameterisedIndexablePages}`. The categorisation the
     Evaluate line asks for is yours to make from `topParams`; the counts are the
     engine's.
  2. `issues_list` with `checkId: "CHECK-27"` — `url.parameter-pages-indexable`
     (info): parameterised URLs that are indexable, which is the "without proper
     canonicals" half. Cross-read CHECK-17 for where those canonicals point.
- **Evaluate**:
  - Categorise params: pagination (?page=), sort (?sort_by=), filter, variant (?variant=), search, tracking (utm_), currency
  - FAIL if parameterised URLs are indexable without proper canonicals
  - Record: parameter type breakdown, canonical coverage per type

### CHECK-28: Tracking parameters (utm, gclid, fbclid)
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-28"` —
  `url.tracking-params-internal` (warning): INTERNAL links carrying tracking
  parameters, which is how a site links itself into a parallel set of parameterised
  URLs. `issue_urls` for the list; `url.param-volumes`' `trackingParams` and the
  `isTracking` flag on `topParams` give the totals.
- **Evaluate**:
  - FAIL if tracking param URLs are indexable without canonical to clean URL
  - Record: count, sample URLs

### CHECK-29: Faceted navigation — risk assessment AND opportunity
- **Priority**: High | **Requires**: Engine + DevTools + GSC
- **Engine**: `metrics_get` with `metricId: "url.param-volumes"` — this check is
  MEASURED, not found, so `issues_list` with `checkId: "CHECK-29"` is refused with a
  pointer to the metric rather than answered empty. The crawl surface the risk half
  asks about is `parameterisedPages` and `parameterisedIndexablePages`, and the
  filter families are the `topParams` names. Whether the facets are crawlable at all
  is CHECK-02; whether robots.txt catches them is CHECK-03.
- **Important — This is NOT just a risk check**: Faceted navigation is both a crawl budget
  risk AND a significant SEO opportunity. Blanket-blocking or canonicalising all filters
  to the base URL may be safe but also kills potential high-value landing pages.

  **Risk**: Unchecked, filters create thousands of thin, near-duplicate parameter URLs.
  **Opportunity**: Single-filter URLs like `/collections/dresses?filter.v.color=Red` could
  serve as the landing page for "red dresses" — a high-volume query. Canonicalising it
  away means you have no page specifically targeting that search intent.

- **DevTools**:
  1. Navigate to a collection page, use sort/filter controls
  2. Observe: does URL change? Are params added?
  3. Check canonical and robots directives on the filtered URL
  4. **Robots.txt wildcard gap analysis**: Cross-reference with CHECK-03 pattern testing.
     Specifically verify that these combinations are handled:
     - Single filter URL (e.g. `?filter.v.size=UK+10`) — blocked, noindexed, or canonicalised?
     - Single filter + pagination (`?filter.v.size=UK+10&page=2`) — blocked?
     - Single blog tag + pagination (`/blogs/journal/tagged/dresses?page=2`) — blocked?
     - Multiple filters (`?filter.v.size=UK+10&filter.v.color=Black`) — blocked?
  5. Calculate potential crawl surface: number of filter values × number of collections ×
     average pagination depth. Flag if this exceeds 10,000 potential URL combinations.
- **Opportunity assessment** (cross-reference with GSC data from CHECK-74):
  1. From CHECK-74, identify high-volume queries that map to filter values:
     - Colour queries: "red dresses", "black dresses", "burgundy dresses"
     - Size queries: "plus size dresses", "petite dresses"
     - Material queries: "satin dresses", "lace dresses"
     - Style queries: "backless dresses", "off-shoulder dresses"
  2. Check: does the site have a dedicated collection page for these, or are they only
     reachable via filters? If only via filters AND the filter URL is canonicalised away,
     there's no landing page for that query.
  3. **Recommendation options** (not a one-size-fits-all — present options):
     - **Option A: Static collections** — Create dedicated collection pages for high-volume
       filter values (e.g., `/collections/red-dresses` instead of `?filter.v.color=Red`).
       Best for SEO but requires manual creation and maintenance.
     - **Option B: Indexable single-filters** — Allow single-filter URLs to be indexed
       with self-referencing canonicals. Block multi-filter combinations. More automated
       but creates more URL surface to manage.
     - **Option C: Status quo** — Keep all filters canonicalised to base. Safest for crawl
       budget but misses keyword opportunity. Only recommend if the site already has
       dedicated collection pages covering all key filter values.
- **Evaluate**:
  - PASS if all filter combinations are handled AND high-volume queries have dedicated landing pages
  - WARN if filters are canonicalised to base but high-volume query opportunities are missed
  - FAIL if filter URLs are indexable without canonical creating crawl bloat
  - Record: current filter handling method, robots.txt gap analysis, **opportunity assessment
    — which high-volume queries lack a dedicated landing page**, recommended strategy option
  - Record: facet handling method (robots.txt, noindex, canonical, none), **specific patterns
    that pass through robots.txt**, estimated crawl surface size

### CHECK-30: Case and trailing-slash normalisation
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-30"` —
  `url.normalisation-variants` (warning): URLs the crawl reached in more than one
  spelling (case, trailing slash) where both answered 200 instead of one redirecting
  to the other. `issue_urls` gives the variant sets.
- **DevTools**: Test an uppercase URL — check if it 301s to lowercase. Test with/without trailing slash
- **Evaluate**:
  - PASS if single canonical version, variants redirect 301
  - FAIL if both versions resolve to 200 without canonical
  - Record: uppercase URL count, redirect behavior

---

## 9. Internal Linking

### CHECK-31: Crawl depth to key pages
- **Priority**: Critical | **Requires**: Engine
- **Engine**:
  1. `metrics_get` with `metricId: "structure.depth-distribution"` — the shape of the
     depth distribution over indexable 200 pages: `{count, min, p25, median, p75,
     p95, max, mean}` for the site and for each page type (`scope: "page_type"`).
     `count` is every page in the cohort; the percentiles describe only the pages
     that HAVE a depth.
  2. `issues_list` with `checkId: "CHECK-31"` — `structure.deep-page` (info) names
     the individual pages past the depth threshold, and `issue_urls` lists them.
  3. **The no-depth bucket is yours to count**, and the check below insists on it:
     the metric does not break it out. Count the indexable pages whose `depth` is
     null — `pages_query` with `indexable: true` shows `depth` per row, and
     `export_crawl` with `dataset: "pages"` gives the whole set when the crawl is
     large. `count` minus the pages that have a depth is the same number from the
     other side; state which way you got it.
- **Analysis**: the distribution is per indexable page — non-indexable pages
  (noindexed, canonicalised, blocked) are excluded, because their crawl depth is
  irrelevant. Present the buckets the table below asks for, with the percentiles from
  the metric beside them.
- **CRITICAL — Include pages with NO crawl depth**: Pages discovered via sitemap only
  (not via any HTML link) have no depth at all. They MUST appear in the distribution as
  "No depth (sitemap only)" — they are the worst case, worse than depth 5+, because they
  have zero link path from the homepage.

  The distribution must always show ALL indexable pages totalling 100%:
  ```
  | Crawl Depth              | Pages | % of All Indexable |
  |--------------------------|-------|--------------------|
  | No depth (sitemap only)  | X     | X%                 |  ← MUST INCLUDE THIS
  | Depth 0 (homepage)       | X     | X%                 |
  | Depth 1                  | X     | X%                 |
  | Depth 2                  | X     | X%                 |
  | Depth 3                  | X     | X%                 |
  | Depth 4                  | X     | X%                 |
  | Depth 5+                 | X     | X%                 |
  | TOTAL                    | X     | 100%               |
  ```

  **Do NOT calculate percentages using only pages that have a depth value.** That hides
  the sitemap-only pages and makes the distribution look healthier than it is. On one
  audit, this error made "41% at depth 4+" look like the main problem — when the real
  finding was 64% had no depth at all.

- **Evaluate**:
  - FAIL if key indexable page types (products, collections) are >3 clicks deep
  - **FAIL if >30% of indexable pages have no crawl depth** (sitemap-only discovery)
  - Cross-reference with CHECK-01 (JS dependency) and CHECK-33b (product discovery) —
    sitemap-only pages often indicate a JS-rendered link structure
  - Record: crawl depth distribution including no-depth bucket (indexable pages only),
    page types at each depth, % of indexable pages at depth >3, **% with no depth**

### CHECK-32: Orphan pages (no internal links)
- **Priority**: High | **Requires**: Engine + GSC
- **Engine**: `issues_list` with `checkId: "CHECK-32"` — two rules:
  - `links.orphan` (warning) — a page the crawl fetched that no other crawled page
    links to. `issue_urls` gives the list, and each row's evidence says how the page
    was discovered and whether the sitemap lists it, which is the SITEMAP breakdown
    the Analysis asks for.
  - `links.orphan-skipped` (info) — the crawl did not run to completion (URLs left
    unfetched, or a page cap reached), so "nothing links to this page" cannot be
    distinguished from "the page that links to it was never crawled". When this
    fires, CHECK-32 is SKIP with the reason quoted, NOT a clean orphan count.
- **CRITICAL — two different orphan populations, and the engine sees one of them**:
  - **Crawl orphans** (the engine's): pages this crawl reached, with no inbound
    internal link from any other crawled page. Complete for what was crawled.
  - **GSC orphans**: URLs Google has impressions for that the crawl never reached at
    all. The engine cannot see these by definition — nothing links to them and it
    never fetched them. Get them from GSC (CHECK-77's inspection data) and report
    them as a separate tier, never merged into the engine's count without saying so.
  A total that silently mixes the two is the reporting error this section exists to
  prevent.

- **Analysis**:
  1. Take the total crawl-orphan count from `issues_list`'s `count` for `links.orphan`
  2. Break down by source: the finding evidence separates sitemap-listed orphans from
     the rest; the GSC tier comes from GSC
  3. **Break down by URL type — but classify carefully**. CDN asset URLs contain
     `/products/` in their path (e.g., `/cdn/shop/products/image.jpg`) and will
     false-positive as product pages if you match on `/products/` alone. Always
     exclude `/cdn/shop/` paths before classifying URL types. Use this order:
     1. CDN assets first: any URL containing `/cdn/shop/` → `cdn_asset`
     2. Then: `/products/` → product page
     3. Then: `/collections/` → collection page
     4. Then: `/blogs/` → blog
     5. Then: `/pages/` → page
  4. **Watch for Shopify collection-scoped product URLs**: Shopify generates two URL
     formats for every product — the canonical `/products/[slug]` and a
     collection-scoped `/collections/[name]/products/[slug]`. Google often indexes
     thousands of collection-scoped URLs as GSC orphans. These are NOT missing products —
     they are Shopify duplicate URLs that should canonical back to `/products/[slug]`.
     Always check: do the GSC product orphans follow the `/collections/.../products/`
     pattern? If so, flag as a Shopify canonical consolidation issue, not a discovery gap.
  5. The GSC orphan count reveals how many pages Google has indexed that have zero
     internal link path — these are the most vulnerable pages on the site
  6. Cross-reference with CHECK-01 and CHECK-33b: if the product grid is JS-dependent,
     the GSC orphan products are the ones Google found via sitemap but can't reach
     through HTML links
- **Evaluate**:
  - FAIL if orphan pages > 0 for important content
  - Severity is based on the **total orphan count across both tiers**, stated tier by tier
  - Do NOT answer this check from `crawl_status` counts — those describe the crawl, not
    the link graph (Evaluation Principle 2). `links.orphan`'s own count is the source
    of truth for the crawl tier.
  - Record: **total orphan count**, breakdown by source (crawl orphans vs GSC-only),
    breakdown by URL type (with CDN excluded), Shopify collection-scoped URL
    count if applicable, percentage of total known URLs

### CHECK-33: Unique inlinks distribution
- **Priority**: Medium | **Requires**: Engine (metrics)
- **Engine**: two metrics, and no findings — `issues_list` with `checkId: "CHECK-33"`
  is refused with a pointer to `metrics_get`, because an inlink count is a
  measurement rather than a fault:
  - `inlinks.distribution` — `{count, min, p25, median, p75, p95, max, mean}` unique
    inlinks per indexable page, for the site and per page type (`scope: "page_type"`)
  - `inlinks.extremes` — the two ends as URLs: the under-linked bottom and the
    top-linked pages, ready to quote
- **Analysis**: This check must present actual numbers, not just pass/fail. From the two
  metrics above, present:
  1. Distribution summary: min, median, mean, max unique inlinks (site row)
  2. Pages with fewest inlinks — these are under-linked (`inlinks.extremes`)
  3. Pages with most inlinks — these receive most equity (`inlinks.extremes`)
  4. Per page type: the same distribution, from the `page_type` rows
  5. Flag important pages (high-traffic from CHECK-73) that have below-average inlinks
- **Evaluate**:
  - WARN if important pages have <3 unique inlinks
  - WARN if significant imbalance (some pages have 100+ inlinks, others have 1-2)
  - Record: full inlinks distribution table, bottom 20 pages, top 20 pages, averages by page type

### CHECK-33b: Product discovery source analysis (e-commerce)
- **Priority**: Critical | **Requires**: Engine (metric) + GSC
- **Important**: This check reveals whether products are discoverable through the HTML link
  graph or depend entirely on the sitemap and JS rendering. It is one of the most impactful
  structural findings for e-commerce sites.
- **Engine**: `metrics_get` with `metricId: "inlinks.sources-by-type"` — one row per
  page-type cohort, whose value is `{sources: {<source page type>: <inlinks>}}`: which
  templates link into this one, and how many distinct page-to-page links they send.
  This check is MEASURED, so `issues_list` with `checkId: "CHECK-33b"` is refused
  with a pointer to the metric.
  - `{sources: {}}` on the product cohort is the finding: **nothing on the site links
    to products at all**.
  - A cohort landing in `(untyped)` means the crawl could not type those pages — say
    so rather than reading the typed cohorts as the whole site.
- **CRITICAL — three populations, do not confuse them**:
  - **Orphan products** = products with zero internal inlinks from anywhere in the
    crawl (`links.orphan`, filtered to the product cohort). Smallest count, worst case.
  - **Products with no crawl depth** = products no HTML link path reaches from the
    homepage, a strictly larger set that includes products linked only from other
    sitemap-discovered pages. `pages_query` with `pageType: "product"` shows `depth`
    per row; the ones with `depth: null` are these.
  - **GSC-only products** = products Google knows and the crawl never reached. Only
    GSC has them.
  The correct number for "products not reachable via HTML" is the second. Reporting
  the orphan count instead under-reports the problem, sometimes by several times.
- **Analysis**: over the product cohort (`pages_query` with `pageType: "product"`, or
  `export_crawl` with `dataset: "pages"` on a large site):
  1. **Link-discovered products**: count products WITH a `depth` value
  2. **Sitemap-only products**: count products with `depth: null`
  3. **GSC-only products**: from GSC — URLs it has impressions for that do not appear
     in the crawl at all
  4. Present as a three-tier breakdown table:
     ```
     | Discovery Source       | Products | % of Total |
     |------------------------|----------|------------|
     | HTML links (with depth)| X        | X%         |
     | Sitemap only (no depth)| X        | X%         |
     | GSC only (not in crawl)| X        | X%         |
     | TOTAL                  | X        | 100%       |
     ```
  5. Cross-reference with CHECK-01: if the product grid is JS-dependent, the "sitemap only"
     and "GSC only" tiers will be large — this confirms the JS rendering impact on real crawl data
  6. Cross-reference with `inlinks.sources-by-type`: an empty or tiny `sources` map on
     the product cohort says the same thing from the link graph's side
- **Evaluate**:
  - PASS if >80% of products have crawl depth (discovered via HTML links)
  - WARN if 30-80% are sitemap/GSC-only
  - FAIL if >80% of products have no HTML link path (entirely dependent on sitemap for discovery)
  - Note: A "FAIL" here combined with a JS-dependent product grid (CHECK-01) means the site's
    product discoverability is fundamentally broken for any crawler that doesn't render JS,
    including Googlebot's initial crawl pass
  - Record: three-tier breakdown table, total products per tier, % distribution,
    cross-reference with CHECK-01 JS dependency finding

### CHECK-34: Navigation and key links in raw HTML
- **Priority**: Critical | **Requires**: Engine (render pass)
- **Engine**: `issues_list` with `checkId: "CHECK-34"` — `nav.js-only` (critical): a
  rendered page whose raw HTML carried almost no nav or footer links while the
  rendered DOM carried a real navigation. `issue_urls` gives the pages, each with
  `{rawNavLinks, rawFooterLinks, rawLinks, renderedNavLinks, renderedFooterLinks,
  renderedLinks}` — the counts this check's Record line asks for, on every page the
  render pass sampled rather than on the homepage alone.
  It needs `renderPassCount` ≥ 1; without a render pass this is SKIP, not PASS.
  Whether the nav contains the RIGHT links (key categories) is judgement — read the
  nav on one page in a browser for that, and say that is what you did.
- **Evaluate**:
  - PASS if main nav and footer links are in initial HTML
  - FAIL if key navigation is JS-only
  - Record: nav link count, footer link count, JS-dependency status

---

## 10. On-Page SEO

### CHECK-35: Title tags — unique, intent-led, not truncated
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-35"` — three rules:
  `title.missing` (warning), `title.too-short` (info), `title.too-long` (info). Use
  `pageType` on `issues_list` to get each count per template cohort directly, which
  is what the per-page-type breakdown below needs; `issue_urls` gives the titles
  themselves in the evidence, which is where the template patterns and the samples
  come from. Duplicate titles are not a rule today — see CHECK-39 for the content-level
  duplicate rules, and record the duplicate-title count as NOT MEASURED rather than
  inferring it from the samples.
- **Important — Analyse by Page Type, Not Just Global Counts**: Saying "99% of titles are
  over 60 chars" tells the client nothing useful. Different page types have different title
  templates, different keyword needs, and different SERP competition. The analysis must
  break down by page type and assess the template pattern, not just count the numbers.
- **Analysis**:
  1. **Global counts**: missing, duplicate, over-60. Quick baseline.
  2. **Break down by page type**: For each type (product, collection, blog, info page),
     separately report:
     - Title template pattern (e.g., `{Product Name} – Brand - UK`)
     - Average length, min/max
     - % over 60 chars
     - Sample of 5 actual titles with SERP truncation preview
  3. **Title template assessment per page type**:

     **Products**: Is the title template optimised for product search?
     - Does it front-load the descriptive keywords or bury them after an internal style name?
     - Does it include product type ("dress", "jumpsuit") in the visible 60 chars?
     - Is the colour/key attribute visible before truncation?
     - Example issue: `"Anavine   Black Round-Neck Mini Dress With..."` — "Anavine" is an
       internal style name that means nothing to searchers, wasting prime title space

     **Collections**: Does the title communicate what the collection sells?
     - A title like `"Satin – Club L London"` tells Google nothing — it should be
       `"Satin Dresses for Women | Club L London"` with keyword modifiers
     - Marketing/editorial collection names ("French Riviera", "On Rotation") are meaningless
       in search — does the title include the actual product category keyword?
     - Are high-volume target queries (from CHECK-74) reflected in the title?

     **Blog**: Does the title match search intent for the topic?
     - Is it a clickable headline or an internal editorial reference?

     **Info/policy pages**: Are they descriptive?

  4. **Brand suffix analysis**:
     - What's the suffix? How many chars does it consume?
     - Is it consistent across page types?
     - Recommendation: brand suffix should be under 12 chars (e.g., `"| Club L"`)
       to leave 48+ chars for the descriptive part

  5. **Whitespace/formatting check**: Look for embedded newlines, double spaces, or
     template whitespace in title strings. These inflate character counts and may display
     oddly in SERPs. Check the raw title string for `\n`, `\r`, or multiple consecutive spaces.

  6. **SERP simulation**: For the top 10 pages by organic clicks (from CHECK-73),
     show what Google actually displays at 60 chars. Flag if important keywords are
     being cut off.

- **Evaluate**:
  - FAIL if missing titles > 0
  - FAIL if collection titles lack category keywords (just marketing names + brand)
  - WARN if duplicates > 5% or over-60-char > 50% of pages
  - WARN if product titles front-load internal style names instead of descriptive keywords
  - WARN if brand suffix > 15 chars (wasting SERP real estate)
  - Record: **per-page-type breakdown** with template pattern, samples, and SERP truncation
    preview. Missing count, duplicate count, over-60 count, brand suffix analysis,
    whitespace issues, top duplicate title groups, SERP simulation for top 10 pages

### CHECK-36: Meta descriptions — unique, compelling, and correct length
- **Priority**: High | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-36"` — `meta-description.missing`
  (warning), `meta-description.too-short` (info), `meta-description.too-long` (info).
  Filter by `pageType` for the per-type breakdown; `issue_urls` carries each
  description and its length, which is what the quality spot-check reads. As with
  CHECK-35, duplicate descriptions are NOT MEASURED by a rule — say so rather than
  estimating.
- **Analysis** (break down by page type, same as CHECK-35):
  1. **Missing count by page type**: Products, collections, blog, info pages separately.
     Blog and info pages often have the highest missing rate — report this specifically.
  2. **Length analysis by page type**: Check average, min, max length per type.
     - Meta descriptions over 155 chars will be truncated/rewritten by Google
     - Under 70 chars may be too short to be compelling
     - Flag if average length is >200 chars (means the template is dumping full product
       descriptions into the meta tag instead of a crafted SERP snippet)
  3. **Quality spot-check**: Read 5 sample descriptions per page type. Are they:
     - Crafted SERP copy that encourages clicks? Or auto-generated from product descriptions?
     - Containing a call to action or value proposition?
     - Within 70-155 char range for optimal SERP display?
     - Garbage content? (e.g., data tables, code, repeated text scraped from page body)
  4. **Duplicate analysis**: Group duplicates by page type. Template-generated duplicates
     (all products share the same description) are worse than coincidental duplicates.
- **Evaluate**:
  - WARN if missing > 10% for any page type
  - WARN if duplicates > 5%
  - **WARN if average length > 200 chars** (descriptions are being truncated — likely
    auto-generated from full product copy rather than crafted for SERPs)
  - FAIL if garbage content found in meta descriptions (data tables, code, foreign language dumps)
  - Record: **per-page-type breakdown** — missing count, average length, over-155 count,
    quality assessment with samples, duplicate groups

### CHECK-37: H1 and heading hierarchy
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-37"` — `headings.h1-missing`
  (warning), `headings.h1-multiple` (info), `headings.level-skip` (info). Filter by
  `pageType` for the per-template counts. The evidence carries the H1 COUNT, not the
  H1 TEXT: the engine can tell you that every product page has two H1s, and cannot
  tell you what they say.
- **Analysis**:
  1. **Global counts**: missing, multiple, level skips — from `issues_list`. Duplicate
     H1 text is NOT MEASURED by a rule.
  2. **Break down multiple H1s by page type** with the `pageType` filter. If a whole
     cohort has the same H1 count above one, a template element is coded as an H1
     (e.g., a geo banner, promo bar, store selector). Confirm WHICH element in the
     browser — one page of the cohort is enough, because the engine has already told
     you the pattern is site-wide.
  3. **If a rogue template H1 is found — TRACE IT in the browser** (one page only):
     Navigate to any page and run this to get the element's DOM location for the dev fix:
     ```javascript
     Array.from(document.querySelectorAll('h1')).map(function(h) {
       return {
         text: h.textContent.trim().substring(0, 60),
         id: h.id,
         classes: h.className,
         parentClasses: h.parentElement?.className,
         grandparentClasses: h.parentElement?.parentElement?.className,
         visible: h.offsetHeight > 0
       };
     })
     ```
     Use this to tell the dev team:
     - **What element it is**: e.g., "geo-detection banner with class `.store-select__heading`"
     - **Which theme file**: class names map to Liquid templates
       (e.g., `.store-select` → `sections/store-selector.liquid`)
     - **The exact fix**: "Change `<h1 class="store-select__heading">` to `<div class="store-select__heading">`"
  4. **H1 ↔ Title alignment check**: For each page type, does the H1 match the title?
     The engine holds the titles (CHECK-35's evidence) but not the H1 text, so this is
     a sampled browser comparison — take 3-5 pages per page type from `pages_query`,
     read both, and say the sample size in the finding.
     They don't need to be identical, but they should reinforce the same topic/keyword.
     **Normalise whitespace before comparing** — collapse multiple spaces, strip newlines,
     and trim. Template whitespace differences (double space vs single space) are a
     formatting bug to flag separately, not a content mismatch.
     Flag if <50% alignment on any page type — it usually means the title template and H1
     template are pulling from different fields.
  5. **H1 keyword assessment** (same logic as CHECK-35 for titles):
     - Product H1s: do they include the product type keyword (dress, jumpsuit)?
     - Collection H1s: do they include the category keyword or just a marketing label?
     - Are H1s descriptive enough for search intent?
  6. **Full heading hierarchy check** (DevTools): On 2-3 page types, extract all headings
     (`h1,h2,h3,h4,h5,h6`) and check the logical structure:
     - Is there a clean H1 → H2 → H3 hierarchy?
     - Are headings used for non-heading elements (nav items as H3, promo text as H4)?
     - Are semantic sections properly headed?
- **Evaluate**:
  - FAIL if missing H1 > 0
  - **FAIL if a template element is incorrectly coded as H1 across all pages** — this is
    a single theme fix (change the tag from `<h1>` to `<div>`) and is always critical
  - WARN if multiple H1 > 5%
  - WARN if H1 ↔ title alignment < 50% on any page type
  - WARN if non-heading elements use heading tags (nav as H3, promo as H4)
  - Record: missing, multiple, duplicate counts, **H1-1 and H1-2 text for each page type**,
    H1 ↔ title alignment %, heading hierarchy assessment, specific template element
    identified if a non-heading is using H1/H2/H3 tags

### CHECK-38: Content quality and intent match
- **Priority**: High | **Requires**: Visual + DevTools + Engine (evidence only)
- **AGENT CHECK — the verdict is yours.** No rule judges this one: whether a page
  serves the intent it targets is not something a crawl settles, and a rule that
  claimed it would be a rule that always passes. Two metrics supply EVIDENCE and
  make no claim:
  - `metrics_get` with `metricId: "content.metrics-by-type"` — the word-count
    distribution per page type, so "the blog is thin" is a number rather than an
    impression
  - `metrics_get` with `metricId: "content.template-similarity"` — how alike the
    pages of each template are, which is where "every product description is the
    same paragraph" shows up
  Quote both, then judge. `issues_list` with `checkId: "CHECK-38"` is refused: there
  are no findings behind an agent check.
- **Visual**: Navigate to 5 key page types (homepage, product, collection, blog, info page). Visually assess:
  1. Content depth — is there substantial, useful content?
  2. Intent match — does the page serve the likely search intent (informational vs transactional)?
  3. Above-the-fold — what does the user see first? Is key content visible without scrolling?
  4. CTAs and conversion elements — clear and accessible?
  5. Take screenshot of each page type for the audit report
- **Blog/article quality** (important — don't rely on analytics data alone):
  1. Navigate to 3-5 random blog/article pages (not just top performers)
  2. Assess each article: depth of coverage, originality, usefulness, readability
  3. Check: is this clearly human-written expert content or generic/AI-generated filler?
  4. Check: does it answer the topic thoroughly or just skim the surface?
  5. Check: are there internal links to relevant products/services/resources?
  6. Note: thin blog content damages site-wide quality signals even if individual articles get low traffic
- **Evaluate**: Subjective — note content quality per page type, with specific blog quality assessment
- **Record**: qualitative assessment per page type, blog article quality sample (3-5 articles reviewed), screenshots

### CHECK-39: Near-duplicate content — root cause analysis
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-39"` — two rules:
  - `content.exact-duplicate` (warning) — pages whose body content is identical
  - `content.near-duplicate` (warning) — pages alike past the similarity threshold
  `issue_urls` gives them: `content.near-duplicate` writes one finding per PAIR
  (`{urlA, urlB, hamming, pageTypeA, pageTypeB}` — the page types are the pair-type
  classification the Analysis asks for, already done), and `content.exact-duplicate`
  one per identical group (`{contentHash, urls, count, pageTypes}`). For the
  template-level view, `metrics_get` with `metricId: "content.template-similarity"`
  says how alike each cohort's pages are on average — a cohort that is uniformly
  similar is root cause (b) or (d) below before you open a single page.
- **Important — Identify the CAUSE, Not Just the Count**: A near-duplicate report can have
  tens of thousands of pairs. Reporting "76K near-duplicate pairs found" is useless without
  understanding WHY they're duplicates. The root cause determines the fix — and different
  causes need completely different solutions.
- **Analysis**:
  1. **Quantify the scale**: Total pairs, unique URLs involved, similarity distribution
     (90-92%, 93-95%, 96-98%, 99-100%)
  2. **Classify pair types**: Group by URL type combination:
     - Product ↔ Product (most common on e-commerce)
     - Collection ↔ Collection
     - Collection ↔ Page
     - Page ↔ Page
     - Blog ↔ Collection
  3. **Identify root causes through browser comparison** (MANDATORY):
     Navigate to 2-3 pairs from each major pair type. For each pair:
     - Open both URLs side by side
     - Extract the product/page description text from each
     - Compare: what's identical? What differs? Is it just a colour/size word swap?
     - Check: is the unique content drowning in template boilerplate (nav, footer, shipping info)?

     **Common root causes to look for:**

     **a) Colour variants as separate URLs**: Same product in different colours gets its
     own URL with a copy-paste description where only the colour word changes. This is
     the most common cause on fashion/apparel sites. The fix is NOT to merge the URLs
     (colour variants should have separate pages for SEO) — the fix is to write unique
     descriptions per colour variant that go beyond swapping one word.

     **b) Template boilerplate domination**: Pages with very little unique content (empty
     collections, thin utility pages) appear as duplicates because the shared template
     (nav, footer, promo bar, cookie consent, delivery info) makes up 95%+ of the text.
     The fix is either adding unique content or noindexing genuinely empty pages.

     **c) Overlapping collections**: Multiple collections targeting similar themes
     (e.g., "burgundy dresses" vs "best-selling burgundy dresses") with the same products
     and no differentiating editorial copy. Fix: consolidate or add unique copy per collection.

     **d) Product template padding**: Product pages include large blocks of shared content
     (shipping info, returns policy, size guide) that dwarfs the unique product description.
     Fix: move shared content to expandable sections so the unique description is the
     bulk of the page's text. (The engine's similarity comparison reads the extracted
     body text, boilerplate included, so a template that dwarfs its unique copy is
     what `content.near-duplicate` will keep reporting until the copy changes.)

  4. **Present findings by root cause**, not just raw pairs:
     ```
     | Root Cause | Pairs | % | Example | Fix |
     |------------|-------|---|---------|-----|
     | Colour variant copy-paste | X | X% | Nobu Black ↔ Nobu Burgundy | Unique descriptions per variant |
     | Template boilerplate | X | X% | on-rotation ↔ studentbeans | Add unique content or noindex |
     | Overlapping collections | X | X% | burgundy ↔ best-selling burgundy | Consolidate or differentiate |
     ```

  5. **Cross-reference with CHECK-78** (data-driven cannibalisation from GSC) — near-duplicate
     content pairs often map to the same cannibalising query groups there
- **Evaluate**:
  - FAIL if colour variant pages have identical descriptions (only colour word differs)
  - WARN if >20% of near-duplicate pairs are from template boilerplate domination
  - WARN if overlapping collections compete for the same queries
  - Record: total pairs, pair type breakdown, **root cause breakdown with examples**,
    browser comparison findings, recommended fix per root cause

### CHECK-40: Thin or placeholder content
- **Priority**: Medium | **Requires**: Engine
- **Engine**: `issues_list` with `checkId: "CHECK-40"` — `content.thin` (warning, the
  same rule CHECK-13 reads) and `content.placeholder` (warning: lorem ipsum and
  friends left in live copy). `issue_urls` for both lists; filter `issues_list` by
  `pageType` to say which templates the thin pages belong to, and read
  `content.metrics-by-type` for the word-count distribution behind the threshold.
- **Evaluate**:
  - FAIL if lorem ipsum > 0 (immediate fix needed)
  - WARN if low content > 10% of indexable pages
  - Record: lorem ipsum count + URLs, low content count by page type

### CHECK-41: E-E-A-T signals
- **Priority**: Medium | **Requires**: Visual + DevTools + Manual
- **AGENT CHECK — no engine evidence at all.** Nothing a crawl stores is evidence for
  E-E-A-T that a rule could summarise without also implying the verdict, so no rule
  of any kind claims this check: `issues_list` and `metrics_get` with
  `checkId: "CHECK-41"` are both refused. The work below is the whole check, and the
  findings record must carry what you actually saw, not a score with nothing under it.
- **Important**: E-E-A-T is not just about surface signals (badges, bios). It must be
  assessed through the actual content, site structure, and topical depth.
- **Experience & Expertise** (assess through content):
  1. Navigate to 3-5 key content pages (blog posts, guides, product descriptions)
  2. Does the content demonstrate first-hand experience with the topic?
  3. Does it show deep expertise (specific details, nuance, practical advice)?
  4. Are claims backed by evidence, data, or references?
  5. Check internal linking: do content pieces link to related topics forming topic clusters?
  6. Is there a coherent topical architecture (pillar pages → subtopics → related content)?
- **Authoritativeness** (assess through site structure):
  1. Navigate to About page — does it establish who is behind the content?
  2. Check for author bios with photos, credentials, and relevant experience
  3. Check for editorial standards or content policy pages
  4. Look for industry certifications, awards, partnerships
- **Trustworthiness** (assess through signals):
  1. Check for trust badges, security seals, customer reviews
  2. Check policy pages: shipping, returns, privacy, terms
  3. Check contact information: physical address, phone, email
- **Topic clustering** (DevTools):
  1. From a key content page, extract internal links: `Array.from(document.querySelectorAll('article a[href], .content a[href]')).map(a => a.href)`
  2. Do content pages link to related subtopics? Is there a hub-and-spoke pattern?
  3. Cross-reference with CHECK-33 (inlinks) — are topic cluster pages well-interlinked?
- **Evaluate**: Assess each E-E-A-T component separately. Especially important for YMYL topics.
- **Record**: Experience score (content depth), Expertise score (demonstrated knowledge), Authoritativeness score (credentials/recognition), Trustworthiness score (trust signals), topic clustering assessment

### CHECK-42: Expired/out-of-stock product handling
- **Priority**: Low | **Requires**: Visual + Engine (context only)
- **AGENT CHECK — the verdict is yours.** No rule claims it: "is this the right way
  to handle an out-of-stock product" is a strategy question, not a fact about the
  markup. For context, `issues_list` with `checkId: "CHECK-13"` (`content.soft-404`)
  shows pages that answer 200 while reading as gone, which is one bad OOS pattern —
  cite it if it fires, but the check is answered in the browser.
- **Visual**: Find an OOS product if possible — check: clear OOS message? Suggests alternatives? Add-to-cart disabled?
- **Evaluate**: Note OOS strategy. WARN if no clear strategy
- **Record**: OOS handling method observed

---

## 11. Structured Data

### CHECK-43: Schema markup audit — types, gaps, and opportunities
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-43"` — `schema.none-on-site` (info):
  the crawl stored no JSON-LD of any type, anywhere. That is the categorical case; a
  site with markup fires nothing here and is judged through its siblings —
  `schema.product-incomplete` (CHECK-44), `schema.breadcrumb-absent` (CHECK-45) and
  `schema.self-serving-reviews` (CHECK-46). Read all four before writing this check up.
  The engine extracts JSON-LD during the crawl, so there is no "validation was not
  enabled" case: if `schema.none-on-site` did not fire, the site published markup.
- **DevTools** (the per-page-type matrix and the opportunity assessment below need the
  documents themselves, which the query surface does not expose):
  - Execute on one page per page type: `JSON.stringify(Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => JSON.parse(s.textContent)['@type']))`
- **Important — Audit Issues AND Opportunities**: This check must cover three things:
  1. **Validation errors** in existing schema (what's broken)
  2. **Missing schema types** that should exist for this site profile (what's absent)
  3. **Missing fields** within existing schema types (what's incomplete)
  Do NOT only report errors. A site can have zero validation errors but still be missing
  high-impact schema types entirely. The opportunity assessment is often more valuable
  than the error list.
- **Analysis**:
  1. Extract JSON-LD from each page type (homepage, product, collection, blog, info page)
  2. Build a current state matrix:

     | Page Type | Schema Types Present | Key Fields |
     |-----------|---------------------|------------|
     | Homepage  | ? | ? |
     | Product   | ? | ? |
     | Collection| ? | ? |
     | Blog      | ? | ? |
     | Info/policy| ? | ? |

  3. Compare against the **expected schema for the site profile**. Use this reference
     table based on site type:

     **E-commerce (fashion/retail):**
     | Page Type | Expected Schema | Rich Result Eligible |
     |-----------|----------------|---------------------|
     | Homepage | Organization (NOT LocalBusiness unless physical stores) | Sitelinks search box, logo |
     | Product pages | Product + Offers + AggregateRating + BreadcrumbList | Product rich results, star ratings, price |
     | Collection pages | ItemList (listing products with position) + BreadcrumbList | Carousel/list results |
     | Blog/articles | Article or BlogPosting + BreadcrumbList | Article rich results |
     | FAQ/policy pages | FAQPage | FAQ accordion in SERPs |
     | Size guide | FAQPage or HowTo | Rich snippet |

     **Common mistakes to flag:**
     - LocalBusiness on every page (should be Organization unless physical retail)
     - LocalBusiness without `geo` property (causes validation errors on every page)
     - Product schema without GTIN/EAN (blocks Google Shopping eligibility)
     - Product without aggregateRating (misses star ratings in SERPs)
     - Collection pages with NO product-level schema (no ItemList)
     - BreadcrumbList with only 2 levels (should include category/collection level)
     - Article schema with non-ISO 8601 dates
     - Missing FAQ schema on high-traffic policy pages

  4. For **collection/category pages** specifically: check if there's an `ItemList` schema
     listing the products. This is a commonly missed opportunity — collection pages often
     have zero product schema even though they're the primary category landing pages.
     `ItemList` with `ListItem` elements (position, name, url, image) tells Google this
     is a product listing and can produce carousel results.

  5. Present findings as two sections:
     - **Issues**: Validation errors and incorrect schema (what needs fixing)
     - **Opportunities**: Missing schema types and fields (what should be added)

- **Evaluate**:
  - FAIL if validation errors > 0
  - WARN if high-impact schema types are missing for the site profile
  - Record: schema types per page type, validation errors, **opportunities matrix showing
    current vs recommended schema per page type**, specific missing fields

### CHECK-44: Product schema completeness
- **Priority**: High | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-44"` — `schema.product-incomplete`
  (warning): a page carrying Product markup that is missing required or recommended
  fields. `issue_urls` names the missing fields PER PAGE in the evidence, across
  every product page the crawl reached — which is the field checklist below, answered
  at site scale instead of on the one product page a person opened.
  A product page with NO Product markup at all is the other half: compare the product
  cohort's size (`pages_query` with `pageType: "product"`) against how many pages the
  rule considered.
- **DevTools** (only for the structure the rule does not judge — the `offers` shape and
  the price format):
  1. Navigate to a product page the engine flagged
  2. Execute: `JSON.stringify(Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => JSON.parse(s.textContent)).filter(d => d['@type'] === 'Product')[0], null, 2)`
  3. The fields the engine checks for, so you can read its evidence against them:

     **Required fields** (must have):
     - name, description, image, url, sku, brand
     - offers: price, priceCurrency, availability, url

     **Recommended fields** (high impact if missing):
     - gtin / gtin13 / ean / mpn — product identifiers for Google Shopping
     - aggregateRating — enables star ratings in SERPs
     - review — individual reviews supporting the rating
     - color — critical for fashion/apparel (high-volume colour queries)
     - material — important for fashion (lace, satin, sequin = search terms)
     - size / pattern — additional product attributes

     **Nice-to-have fields**:
     - weight, width, height — shipping-relevant
     - itemCondition — new/used
     - category — Google product taxonomy

  4. Check the `offers` structure: is it a single Offer or array of Offers (one per
     variant/size)? An array with per-size availability is richer than a single offer.
  5. Check price format: must use decimal point (225.95) not comma (225,95)
- **Evaluate**:
  - FAIL if Product schema missing on product pages
  - FAIL if missing GTIN/identifiers (blocks Google Shopping features)
  - WARN if missing aggregateRating, color, material
  - Record: fields present/absent as a checklist, **specific field-level opportunities
    ranked by impact**

### CHECK-45: BreadcrumbList schema
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-45"` — `schema.breadcrumb-absent`
  (info): the crawl found no `BreadcrumbList` anywhere on this site. Site-scoped, so
  it is one finding rather than a page list, and its evidence carries the indexable
  page count it saw — the rule stays quiet on a site too small to have a hierarchy
  worth marking up.
- **DevTools**: If breadcrumbs DO exist, the accuracy half is a browser check — on a
  product/collection page, extract the BreadcrumbList JSON-LD and compare it to the
  visible breadcrumb
- **Evaluate**:
  - WARN if BreadcrumbList missing
  - FAIL if schema doesn't match visible breadcrumb
  - Record: presence, accuracy

### CHECK-46: Review & rating markup
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-46"` — `schema.self-serving-reviews`
  (info): pages publishing review or rating markup the site wrote about itself, which
  Google's guidelines exclude from rich results. `issue_urls` for the pages.
- **DevTools**: Where the markup exists and the rule is quiet, spot-check one product
  page for the Review/AggregateRating shape and its source attribution
- **Evaluate**:
  - Note presence/absence
  - WARN if self-serving reviews without third-party source
  - Record: review schema type, source, compliance

---

## 12. Performance & CWV

### CHECK-47: Core Web Vitals — LCP, INP, CLS
- **Priority**: High | **Requires**: DevTools
- **Engine**: NOT MEASURED. The engine records response time per page (CHECK-50) and
  nothing else about performance: it does not call PageSpeed, does not collect CrUX
  field data and does not compute Core Web Vitals. This check is browser work in
  full, and if no browser is available it is SKIP — never PASS.
- **DevTools**: Run Lighthouse audit on 3-5 key page types (homepage, product, collection, blog, search)
- **Evaluate**:
  - Prefer CrUX field data (p75) if available; otherwise lab Lighthouse data
  - FAIL if any CWV "Poor" (LCP >4s, INP >500ms, CLS >0.25)
  - WARN if "Needs Improvement" (LCP 2.5-4s, INP 200-500ms, CLS 0.1-0.25)
  - Record: LCP, INP, CLS per page type

### CHECK-48: Render-blocking resources and JS bundle size
- **Priority**: Medium | **Requires**: DevTools
- **DevTools**: Lighthouse audit — check "Eliminate render-blocking resources" and "Reduce unused JavaScript"
- **Evaluate**:
  - WARN if render-blocking resources > 3 or unused JS > 50%
  - Record: render-blocking list, unused JS percentage

### CHECK-49: Image optimisation and responsive images
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-49"` — `images.missing-dimensions`
  (info) and `images.missing-alt` (info), page by page across the whole crawl.
  `issue_urls` names the pages and the offending images. Image WEIGHT and FORMAT are
  not measured (the crawler does not fetch image bytes) — those stay browser work.
- **DevTools**: Check the network panel for image formats (WebP/AVIF vs PNG/JPG) and file
  sizes. Check srcset/sizes on product images
- **Evaluate**:
  - WARN if >100KB images on key pages, no modern formats, or missing dimensions
  - Record: oversized image count, format breakdown, missing dimensions count

### CHECK-50: TTFB, caching, and compression
- **Priority**: Medium | **Requires**: Engine + DevTools
- **Engine**: `issues_list` with `checkId: "CHECK-50"` — `performance.slow-response`
  (info): pages whose response time crossed the threshold, with the measured time in
  the evidence. This is server response time over a whole crawl, which is a better
  sample than one browser load — but it is response time only. Caching headers,
  compression and protocol are not stored, so they stay browser work.
- **DevTools**: Check the homepage's network panel for TTFB and response headers
  (Cache-Control, Content-Encoding, protocol)
- **Evaluate**:
  - WARN if TTFB >600ms, no compression, or no caching headers
  - Record: TTFB values, compression method, caching policy, protocol

### CHECK-51: JavaScript errors and broken network requests
- **Priority**: Medium | **Requires**: DevTools
- **DevTools**:
  1. Navigate to homepage, product, collection
  2. Check console: `list_console_messages` — filter errors
  3. Check network: `list_network_requests` — filter 4xx/5xx
- **Evaluate**:
  - WARN if JS errors on key pages
  - FAIL if errors affect critical functionality
  - Record: error types, affected pages, failed network requests

### CHECK-52: Mobile viewport, tap targets, sticky overlays
- **Priority**: Medium | **Requires**: Engine + DevTools + Visual
- **Engine**: `issues_list` with `checkId: "CHECK-52"` — `mobile.viewport-missing`
  (warning): pages with no viewport meta tag, across the crawl rather than on the two
  pages a browser check would reach. Tap targets and overlays are visual and stay below.
- **DevTools**: Resize to 375x812 and work through the visual checks
- **Visual**: Navigate homepage and product page on mobile viewport. Visually assess: tap target spacing, intrusive overlays (consent banners, chat widgets, promo bars), sticky elements blocking content
- **Evaluate**:
  - FAIL if viewport meta missing
  - WARN if intrusive overlays cover significant content
  - Record: viewport tag, overlay observations

---

## 13. GEO / AI Visibility

### CHECK-53: GA4 setup and AI traffic tracking
- **Priority**: Critical | **Requires**: GA4 + DevTools
- **DevTools**: Check GA4 presence: `!!document.querySelector('script[src*="googletagmanager"],script[src*="gtag"]')`
- **GA4 MCP**: `run_report` with:
  1. Check channel groupings: dimensions `sessionDefaultChannelGroup`, metrics `sessions` — verify organic channels are properly classified
  2. Check AI traffic: dimensions `sessionSource`, `sessionMedium`, metrics `sessions`, `engagementRate` — filter for AI sources (chatgpt, perplexity, claude, etc.)
  3. If AI traffic exists, cross-reference with CHECK-76 findings
- **Evaluate**:
  - FAIL if GA4 tag not present on site
  - WARN if no custom channel group for AI traffic (all AI traffic falling into "Referral")
  - Record: GA4 tag presence, channel groups list, AI traffic classification status, recommendation for AI channel setup if missing

### CHECK-54: Content modularisation for AI extraction
- **Priority**: High | **Requires**: DevTools + Visual
- **DevTools**:
  1. Navigate to 2-3 top content pages
  2. Execute: `Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(h => h.tagName + ': ' + h.textContent.trim())`
  3. Check for structured Q&A, lists, tables, definition-style content
- **Evaluate**:
  - PASS if clear headings, modular sections, entity-rich paragraphs
  - WARN if wall-of-text without structure
  - Record: heading structure quality, modular content patterns

### CHECK-55: Schema markup for AI context
- **Priority**: High | **Requires**: Engine + DevTools (cross-ref CHECK-43)
- **Evaluate**: From CHECK-43 — focus on AI-relevant types: Product, FAQ, HowTo, Organisation, Article
- **Record**: Reference CHECK-43, note AI-specific schema gaps

### CHECK-56: Entity mapping and topic graphs
- **Priority**: Medium | **Requires**: Manual + Visual
- **DevTools**: Check pillar page structure — do pillar pages link to subtopics and vice versa?
- **Evaluate**: Subjective — note topical authority structure
- **Record**: qualitative assessment

### CHECK-57: FAQ and help hub content
- **Priority**: Medium | **Requires**: DevTools + Engine
- **DevTools**: Navigate to FAQ/help/support pages if they exist. Check for structured Q&A format
- **Engine**: find the candidates first — `pages_query` (or `export_crawl` with
  `dataset: "pages"` on a large site) and look for /faq, /help, /support paths. The
  query surface has no URL filter, so match the paths yourself over the listing
  rather than guessing which pages exist
- **Evaluate**:
  - WARN if no FAQ content exists
  - Record: FAQ presence, format, FAQ schema (from CHECK-43)

### CHECK-58: OpenAI Shopping Feed (e-commerce)
- **Priority**: Medium | **Requires**: DevTools + Manual
- **DevTools**: Check if product feed exists (e.g. /products.json on Shopify, or dedicated feed URL)
- **Evaluate**: Note feed availability — full spec check is manual
- **Record**: feed URL if found, basic field check

### CHECK-59: Bing Webmaster Tools
- **Priority**: Medium | **Requires**: Manual
- **Record**: Flag for manual check — verify Bing WMT submission

### CHECK-60: LLM.txt and markdown options
- **Priority**: Low | **Requires**: DevTools
- **DevTools**:
  1. Navigate to `{domain}/llms.txt` — check if exists (200 vs 404)
  2. Navigate to `{domain}/.well-known/llms.txt`
  3. Navigate to `{domain}/llm.txt`
- **Evaluate**: Note presence/absence (emerging practice, not a failure)
- **Record**: which files exist, content summary if present

### CHECK-61: PDP clarity and policy pages
- **Priority**: Medium | **Requires**: Visual
- **DevTools**:
  1. Navigate to a product page — check for clear info (price, availability, shipping, returns)
  2. Navigate to shipping, returns, privacy policy pages — check completeness
- **Evaluate**:
  - WARN if key policy pages missing or thin
  - Record: policy pages found, completeness assessment


### CHECK-62: Google UCP (Universal Commerce Protocol) readiness
- **Priority**: High | **Requires**: DevTools + Manual
- **DevTools**:
  1. Check if Google Merchant Center product feed is available and current
  2. Check for structured product data accessible via API (variants, inventory, pricing)
  3. Check for identity linking support (loyalty/member benefits)
  4. For Shopify: check if Storefront MCP integration is active
  5. For others: check for REST/JSON catalog endpoints
- **Evaluate**:
  - Note: UCP is Google's open standard for agentic commerce (launched Jan 2026)
  - WARN if no product feed or catalog API exists (site invisible to AI shopping agents)
  - Record: feed availability, catalog API status, identity linking, platform integration status

### CHECK-63: OpenAI ACP (Agentic Commerce Protocol) readiness
- **Priority**: Medium | **Requires**: DevTools + Manual
- **DevTools**:
  1. Check if Stripe is the payment processor (simplifies ACP integration)
  2. Check for product feed endpoint (ACP requires gzip-compressed feed pushed to OpenAI)
  3. Verify product data completeness: title, description, price, availability, images, identifiers
  4. For Shopify: check if native ACP integration is available
- **Evaluate**:
  - Note: ACP is maintained by OpenAI + Stripe, powers ChatGPT Instant Checkout (US, expanding)
  - WARN if no checkout API or Stripe integration (blocks ChatGPT commerce)
  - Record: payment processor, feed availability, product data completeness, integration readiness

### CHECK-64: WebMCP and site-level MCP server implementation
- **Priority**: Medium | **Requires**: DevTools + Manual
- **DevTools**:
  1. Check if the site exposes MCP endpoints for AI agent interaction
  2. For Shopify: check Storefront MCP availability (Hydrogen Winter 2026+)
  3. Check for A2A (Agent-to-Agent) protocol support
  4. Navigate to `{domain}/.well-known/mcp.json` or similar discovery endpoint
- **Evaluate**:
  - Note: WebMCP is a browser-level standard allowing AI agents to interact with sites via structured tools
  - This enables any AI assistant to interact with the store (not platform-specific)
  - Record: MCP endpoint availability, tools exposed, A2A support, platform compatibility


---

## 14. Shopify-Specific (if applicable)

Skip this section if site is not on Shopify.

### CHECK-65: Collection-scoped vs root product URLs
- **Priority**: High | **Requires**: Engine
- **Engine**: `pages_query` (or `export_crawl` with `dataset: "pages"`) and filter the
  URLs yourself for the `/collections/*/products/*` pattern, reading `indexable` on
  each; then `issues_list` with `checkId: "CHECK-17"` (`canonical.points-elsewhere`)
  and `issue_urls` to see where those URLs' canonicals actually point
- **Evaluate**:
  - FAIL if both /collections/x/products/y AND /products/y are indexable
  - PASS if collection-scoped URLs canonical to root /products/y
  - Record: collection-scoped product URL count, canonical handling

### CHECK-66: Variant URLs (?variant=)
- **Priority**: High | **Requires**: Engine
- **Engine**: `metrics_get` with `metricId: "url.param-volumes"` — look for `variant`
  in `topParams` and read its occurrence count; then `issues_list` with
  `checkId: "CHECK-27"` (`url.parameter-pages-indexable`) for whether those URLs are
  indexable, and CHECK-17 for where their canonicals point
- **Evaluate**:
  - PASS if variant URLs canonical to main product
  - FAIL if variant URLs indexable without canonical
  - Record: variant URL count, canonical handling

### CHECK-67: Search and tag page explosion
- **Priority**: High | **Requires**: Engine
- **Engine**: `pages_query` with `indexable: true` (or the pages export) filtered to
  /search and /tagged paths for the indexable ones, `indexable: false` for the
  excluded ones, and `issues_list` with `checkId: "CHECK-03"` for what robots.txt
  blocks. Three lists, one question: are these pages in the index or out of it
- **Evaluate**:
  - PASS if /search and /tagged noindexed or blocked
  - FAIL if indexable (creates bloat)
  - Record: /search count, /tagged count, indexability status

### CHECK-68: Markets geo logic and bot access
- **Priority**: High | **Requires**: Engine + DevTools (cross-ref CHECK-24 to CHECK-26)
- **Engine**: the same hreflang findings and coverage metric as CHECK-24–CHECK-26
- **DevTools**: Test market-specific URLs (/en/, /es/), verify content differs, hreflang correct
- **Evaluate**: Cross-reference hreflang findings
- **Record**: Reference hreflang results, market-specific observations

### CHECK-69: Theme bloat and app-injected scripts
- **Priority**: Medium | **Requires**: DevTools + Visual
- **DevTools**:
  1. Navigate to homepage
  2. Count scripts via Network tab, identify third-party app scripts
  3. Check total page weight and JS weight
  4. Lighthouse: "Reduce unused JavaScript"
- **Evaluate**:
  - WARN if total JS >500KB or >10 third-party scripts
  - Record: total JS size, script count, top third-party scripts

### CHECK-70: Collection page copy and editorial blocks
- **Priority**: Medium | **Requires**: Engine + Visual
- **Engine**: `issues_list` with `checkId: "CHECK-40"` and `pageType: "collection"`
  (`content.thin`) for the collections with no copy, plus `metrics_get` with
  `metricId: "content.metrics-by-type"` for the cohort's word-count range — which is
  exactly the "word count range" the Record line asks for
- **DevTools**: Navigate to 2-3 collection pages — check for unique editorial copy above/below product grid
- **Evaluate**:
  - WARN if collection pages have no unique copy
  - Record: collections with/without copy, word count range

---

## 15. Backlinks & Brand Authority (Ahrefs)

Skip this section if the Ahrefs MCP server is not connected. Mark all checks N/A if the
client does not have an Ahrefs subscription linked to the MCP server.

These checks run in Phase 0 alongside GSC and GA4 — they do not depend on the crawl.

### CHECK-79: Backlink profile and domain authority
- **Priority**: High | **Requires**: Ahrefs MCP
- **Ahrefs MCP**:
  1. `site-explorer-domain-rating` — get current Domain Rating (DR) for the root domain
  2. `site-explorer-domain-rating-history` — get DR trend over the past 12 months
  3. `site-explorer-backlinks-stats` — total backlinks, referring domains, dofollow vs nofollow split
  4. `site-explorer-referring-domains` — top 20 referring domains by DR, check for high-authority links
  5. `site-explorer-broken-backlinks` — external links pointing to 4xx/5xx pages on the site
  6. `site-explorer-anchors` — top 20 anchor texts, assess brand vs keyword ratio
- **Evaluate**:
  - FAIL if broken backlinks exist (lost link equity — reclaim by fixing destination or redirect)
  - WARN if DR trend is flat or declining over 12 months
  - WARN if anchor text profile is dominated by generic terms (low topical authority signal)
  - Record: current DR, referring domain count, broken backlink count + URLs, anchor text distribution (brand / keyword / naked URL / generic split)

### CHECK-80: AI citations and brand share of voice
- **Priority**: High | **Requires**: Ahrefs MCP (Brand Radar)
- **Note**: Brand Radar requires a separate Ahrefs subscription tier. If not available, mark as SKIP.
- **Ahrefs MCP**:
  1. `brand-radar-impressions-overview` — total impressions across AI platforms (ChatGPT, Perplexity, Gemini, Copilot)
  2. `brand-radar-sov-overview` — share of voice vs competitors in AI results
  3. `brand-radar-ai-responses` — sample AI-generated answers where the brand appears; note which queries trigger citations
  4. `brand-radar-cited-pages` — which site pages are being pulled into AI answers
  5. `brand-radar-cited-domains` — which external sources are being cited alongside the brand in AI responses
- **Evaluate**:
  - FAIL if brand has zero AI impressions on primary commercial queries (brand invisible to AI)
  - WARN if cited pages are not the most commercially important pages (e.g. homepage cited but no collection pages)
  - WARN if share of voice is significantly lower than key competitors
  - Record: total AI impressions, platform breakdown, top cited pages, top citing contexts, share of voice figure, competitor comparison if available

### CHECK-81: Unlinked brand mentions
- **Priority**: Medium | **Requires**: Ahrefs MCP (Brand Radar)
- **Note**: Brand Radar required. Mark as SKIP if not available.
- **Ahrefs MCP**:
  1. `brand-radar-mentions-overview` — total brand mentions across the web (linked + unlinked)
  2. `brand-radar-mentions-history` — mention volume trend over time
- **Evaluate**:
  - WARN if mention volume is growing but linking domains are flat (unlinked mention gap — link reclamation opportunity)
  - Record: total mentions, linked vs unlinked split, trend direction, top domains mentioning the brand without linking

---

## Reading a Crawl Out of the Engine

There is no export step to run before the checks: the crawl already holds the data,
and each check names the call that answers it. What follows is the shape of those
calls, so a check's one-line **Engine** entry is enough.

The tools are the MCP surface (`crawl_start`, `crawl_status`, `crawl_list`,
`crawl_render`, `crawl_rules`, `crawl_mark_failed`, `issues_list`, `issue_urls`,
`metrics_get`, `pages_query`, `export_crawl`). The HTTP API exposes the same
service — `GET /crawls/:id/issues`, `/metrics`, `/pages`, `/issues/:ruleId/urls`,
`/export` — and answers the same JSON, so an operator running `npm run api:serve`
instead of `npm run mcp:serve` changes the transport and nothing else.

**The three query tools, and what each is for:**

| Tool | Answers | Use it for |
|------|---------|-----------|
| `issues_list` | one row per rule that found something: `{ruleId, checkIds, severity, category, title, count, sampleUrls}` | the verdict on a check, and its size |
| `issue_urls` | one row per finding: `{url, evidence}` | the URL list a developer gets, and the per-page evidence |
| `metrics_get` | `{metricId, scope, scopeValue, value, title, explanation, checkIds, category}` | every number a report quotes |

**Filters that matter for a checklist walk:**

- `issues_list` takes `checkId` — this is how you walk this file. It also takes
  `severity`, `ruleId`, `category` and `pageType`, which intersect.
- `metrics_get` takes `metricId`, `scope` (`site`, `page_type`, `sitemap_doc`) and
  `scopeValue`.
- `pages_query` takes `pageType`, `statusCode`, `indexable` and `rendered`. There is
  no URL filter: match paths yourself over the listing.

**Every listing is paginated.** `{items, nextCursor}`; pass `nextCursor` back as
`cursor` with the SAME filters. `nextCursor: null` is the end. A first page is not
the answer to "how many" — `issues_list`'s `count` is.

**A refusal is not an empty answer.** A filter naming something this ruleset does not
define is refused BY NAME, so an empty page always means "nothing found" and never
"you asked wrong". Two refusals are routine and both are informative:

- `checkId 'CHECK-08' is claimed only by metric rules … it is measured, not found` —
  go to `metrics_get`. CHECK-08, CHECK-29, CHECK-33 and CHECK-33b answer this way.
- `checkId 'CHECK-41' is claimed by no rule` — an agent check. There is no engine
  answer and there is not meant to be one.

**When a crawl is large**, `export_crawl` writes one dataset (`issues`, `pages`,
`metrics`) to a gzipped JSONL file on the server and answers `{dataset, path, rows,
bytes}` — the path, never the contents. Use it when you need every row (the full
4xx list, a site-wide page census) rather than paging thousands of rows through a
context window. The file is for a human or a pipeline; the counts and the samples
are what belong in the audit.

## Crawl Configuration Requirements

The crawl that feeds this checklist is configured at `crawl_start` (see the
`ariadne-crawl` skill for the full procedure). There is no GUI, no config file and
no per-check extraction switch: the crawler stores every field the rules read on
every crawl, so the settings below are about SIZE and REACH, not about coverage.

**What to set, and what it costs the checklist if you do not:**

| Field | Default | Why a check needs it |
|-------|---------|---------------------|
| `maxPages` | 500 | A cap the crawl hits leaves the frontier undrained, which makes CHECK-32 SKIP (`links.orphan-skipped`) and every "% of pages" figure a floor. Size it to the site. |
| `maxDepth` | unset | Truncating depth truncates CHECK-31's distribution and orphans everything past the cut. |
| `probeHosts` | on | Off means CHECK-14 and CHECK-15 are SKIP (`host.probe-skipped`) — the probe is the only evidence there is. |
| `legacyHosts` | none | The only way CHECK-15 can report a legacy host still serving content. Each entry must be on the operator's allowlist in its own right. |
| `renderBudgetPct` / `renderMaxPages` / `renderSamplePerType` | see the tool description | The render pass's sample. CHECK-01, CHECK-02, CHECK-34 and the JS-redirect half of CHECK-10 are measured over the pages it reaches and no others. |
| `perHostDelayMs` / `maxConcurrency` | polite defaults | Politeness, not throughput. Leave them alone unless the site's owner has asked for something specific; robots.txt's own `crawl-delay` wins when it is longer. |

**Then run the passes in order**: `crawl_render` (optional, but before the rules) and
`crawl_rules` (required — nothing below is answerable until the rules have run).

**Analytics and browser access are separate**, and neither is part of the crawl:
GSC, GA4 and Ahrefs are MCP servers the operator connects, and the browser checks
need a browser MCP server. A missing one is a SKIP with the tool named, never a
silent pass.

If the crawl is missing data a check needs — no render pass, a page cap reached, the
host probe off — say so in that check's findings record and recommend a re-crawl with
the field named. A gap that is written down is a gap the next crawl can close; a gap
that is quietly rounded to PASS is a wrong audit.

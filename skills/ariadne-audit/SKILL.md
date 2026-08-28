---
name: ariadne-audit
description: >
  Run a full SEO & GEO audit against an Ariadne crawl: analytics context from GSC,
  GA4 and Ahrefs, then the 82-check checklist, with every crawl-derived check answered
  by quoting the engine and every judgement check answered by the agent. Produces a
  findings file the report and action-plan skills consume. Use this skill when the
  user says: "run the audit", "audit this site", "audit the crawl", "run the
  checklist", "what did the crawl find", "what are the issues", "evaluate the crawl",
  "SEO audit", "GEO audit", "work through the checks", "produce the audit findings".
  It needs a finished, judged Ariadne crawl — if there is none, it calls the
  ariadne-crawl skill first.
---

# Ariadne — the audit orchestrator

This skill walks `checklist.md` (same directory) end to end and writes a findings
file. The checklist is the authority on WHAT each check asks and how to judge it;
this file is the authority on the ORDER of the work and the shape of the output.

## The division of labour, which is the whole design

**The engine produces facts. You produce judgement.**

The crawl, the render pass and the rule run have already looked at every page of the
site. A rule states what it found — 128 sitemap URLs that are not indexable, 4,000
products with no HTML link path, a nav that only exists after JavaScript — and never
states what it means. Severity in this site's context, priority against this client's
commercial position, and the narrative that ties twelve findings into three problems:
those are yours, and nothing in the engine will produce them for you.

**The skill-side hard rule: never re-judge a claimed check by eyeball.** If the
checklist's **Engine** line names a rule or metric, the answer is the engine's output,
quoted. Do not open one page in a browser and grade the check on what that page
showed. One page is not a site, and a hand check that contradicts the engine is a bug
report about the rule — raise it as one — not a finding about the client.

**And the mirror of it: an empty answer is not a clean site.** `issues_list` and
`metrics_get` answer `{"items": []}` for a rule that found nothing AND for a crawl
nobody judged. Only the `crawl_rules` summary distinguishes them.

## Prerequisites

- A running Ariadne server, MCP preferred (`npm run mcp:serve`), HTTP as the fallback
  (`npm run api:serve` with `ARIADNE_API_TOKEN`). See the `ariadne-crawl` skill.
- A crawl of the site that is `finished`, rendered if the site needs it, and JUDGED.
- GSC and GA4 MCP servers for Phase 0. Ahrefs MCP if the client has it.
- A browser MCP server for Phase 3.
- A working directory for this audit's output.

Missing pieces are named, not worked around: an audit that quietly skipped Phase 0
because GA4 was not connected is an audit that mis-prioritised everything downstream.

## The phases

```
Phase 0  Analytics context      GSC + GA4 + Ahrefs        CHECK-71 … CHECK-81
Phase 1  The crawl              ariadne-crawl             (no checks)
Phase 2  Engine-answered checks issues_list / metrics_get CHECK-01 … CHECK-46
Phase 3  Agent checks           browser + judgement       CHECK-38/41/42, 47 … 70
Phase 4  Findings assembly      the findings file         all of them
```

Phase 0 runs FIRST and Phase 1 can run beside it — the analytics work needs no crawl,
and a site losing 40% of its organic traffic has different priorities from one growing
steadily. That context is what turns a list of faults into an audit.

---

## Phase 0 — analytics context

Establish where the site stands before deciding what its technical faults cost. The
checklist's section 0 and section 15 carry the check definitions; this is the order
and the disposition.

1. **Identify the properties.** GSC `list_properties` and GA4
   `get_account_summaries`, matched to the domain. Record the property ids — every
   later query needs them, and picking the wrong property is a whole audit written
   about someone else's site.
2. **Run the section 0 checks** in order: CHECK-71 (organic traffic, segmented and
   trended), CHECK-72 (brand vs non-brand), CHECK-73 (top pages), CHECK-74 (query
   landscape and striking distance), CHECK-75 (conversions), CHECK-76 (AI referral
   traffic), CHECK-77 (indexation coverage — this one crosses GSC against the crawl,
   so it needs Phase 1), CHECK-78 (cannibalisation).
3. **Run the section 15 checks if Ahrefs is connected**: CHECK-79 (backlink profile
   and DR), CHECK-80 (AI citations and share of voice), CHECK-81 (unlinked mentions).

**Ahrefs is optional, and "optional" means SKIP, not silence.** If the Ahrefs MCP
server is not connected, record CHECK-79, CHECK-80 and CHECK-81 as `verdict: "SKIP"`
with `notes` naming the missing server. Brand Radar is a separate subscription tier:
if Site Explorer answers and Brand Radar does not, CHECK-79 is real and CHECK-80 and
CHECK-81 are SKIP. Never infer authority data from anything else.

Carry three things out of this phase into every later verdict: the traffic direction,
which page types earn the money, and which pages are already winning. A critical
finding on a page type with no traffic and no revenue is not the top of the plan.

---

## Phase 1 — the crawl

Use the **`ariadne-crawl`** skill. Either it starts a crawl, or you locate an existing
one with `crawl_list` and confirm it is fit to audit.

A crawl is fit to audit when:

- `status` is `finished` (`cancelled` and `failed` crawls can still be audited, but
  every count becomes a floor and the findings file must say so in `crawl.caveats`);
- the frontier drained — `pending` and `leased` at 0. A crawl that stopped at its page
  cap makes CHECK-32 unanswerable (`links.orphan-skipped` fires and says why);
- `renderPassCount` ≥ 1 if the site needs rendering. Without it, CHECK-01, CHECK-02,
  CHECK-34 and CHECK-10's JS-redirect half are SKIP, not PASS;
- the rules have run, and **you have the `crawl_rules` summary**. If you did not run
  them yourself, run them now: it is idempotent, it re-judges with the current
  ruleset, and its summary is the evidence every empty answer downstream leans on.

Record the crawl's shape before reading a single finding. It bounds every claim the
audit makes.

---

## Phase 2 — the engine-answered checks

The checklist's crawl-derived range is CHECK-01 to CHECK-46 (47 checks, counting
CHECK-33b). **45 of them have a rule behind them** — 44 with finding rules, plus
CHECK-38, whose two metric rules supply evidence and pass no verdict. Only CHECK-41
and CHECK-42 have no rule of any kind. Three of the 47 are judgement — CHECK-38,
CHECK-41 and CHECK-42 — and belong to Phase 3 whatever evidence exists for them.

### 2.1 Sweep first, then walk

Two unfiltered, paginated sweeps give you the whole picture before you commit to a
check, and the issues sweep is usually one call:

1. `issues_list` with no filter but `crawlId` — every rule that found something, with
   its `checkIds`, `severity`, `count` and five `sampleUrls`. Follow `nextCursor` to
   the end. Index the rows by check id.
2. `metrics_get` with no filter — every measured number, each with its own
   `checkIds`, `title` and `explanation`. Follow the cursors. Index by check id too.

**Every listing takes `limit`** — 50 by default, 200 maximum — and using it is the
difference between 3 calls and 12 on a 551-page census. Take the maximum on any sweep
you intend to read in full.

The metrics sweep is the one that does not stay cheap: metric rows are per page type,
and page types are per URL path (see §2.2), so a mid-sized site can produce hundreds
of rows. When the unfiltered sweep runs past two or three pages, index by
`metricId` instead — one call per metric id, plus `scope: "site"` for the site-wide
rows — which is both fewer calls and easier to quote. `metrics_get` has no `checkId`
filter, by design: a metric answers whatever checks name it, and it is the rows'
`checkIds` you index on.

Now walk the checklist in order. For each check, the sweep has already answered one
of three ways:

- **Rows for this check id** → read them, and pull the URL list with `issue_urls`
  where the check's Record line asks for one.
- **No rows, and the check is claimed by a finding rule** → candidate PASS. It is a
  PASS only because the `crawl_rules` summary says the rules ran; cite that summary
  in the evidence.
- **No rows because the check is measured, not found** → the metrics sweep has it.
  Five checks are metric-only — CHECK-08, CHECK-29, CHECK-33, CHECK-33b and CHECK-38
  — and `issues_list` with their `checkId` is refused with a pointer to `metrics_get`
  rather than answered empty. That refusal is a useful thing to see once; it is not an
  error to work around. (CHECK-38's metrics are evidence for a judgement you still
  make yourself — see Phase 3.)

### 2.2 Reading the answers

- **Quote, don't paraphrase.** The `count`, the `sampleUrls`, the metric's `value` —
  these go into the findings file as they came back. A number you retyped is a number
  nobody can trace.
- **`count` is the rows the rule listed; `sampleUrls` is five of them.** Never report
  the sample as the extent of a problem — and do not assume the count is the extent
  either. Some rules stop listing at a cap, and a capped group says so:
  - `truncated: true` with **`total`** — the rule counted every case and listed some.
    `total` is the magnitude. Quote it: "243 orphaned pages, 200 listed".
  - `truncated: true` with **`atLeast`** — the rule stopped *looking*, so the number
    is what it SAW and the real one is unknown. Say "at least 501"; never round it
    into a total, and never quote it as one.
  - **no `truncated` field** — `count` is the whole number, and that absence is the
    only thing that licenses reporting it as one.

  On the Phase 6 gate site `links.orphan` answered `{count: 200, truncated: true,
  total: 243}` and `content.near-duplicate` `{count: 500, truncated: true, atLeast:
  501}`. Quoting the counts would have understated the first by 43 pages and stated
  the second as a fact nothing had counted. (Where a `pageType` filter is on, `count`
  is that cohort's rows while `total`/`atLeast` stay the whole rule's magnitude — the
  two are not two ends of one fraction.)
- **Evidence shapes belong to their rules.** `issue_urls` returns `{url, evidence}`
  and the evidence's fields are whatever that rule wrote — read what it gives you
  rather than expecting a fixed set. `url` is null on a site-scoped finding (a fact
  about the crawl, not about a page).
- **Severity is the rule's opening bid.** `critical`, `warning`, `info` are what the
  rule asserts in the abstract. You may raise or lower it for this site — a `warning`
  on the templates that earn the revenue outranks a `critical` on a page type nobody
  visits — but say that you did, in `notes`.
- **Page-type cohorts are the crawl's own template detection.** `issues_list` and
  `pages_query` both take `pageType`, and metrics carry it as `scopeValue`. Prefer
  those cohorts to path guesses. `(untyped)` is the pages the crawl could not type:
  report it as its own bucket rather than folding it into a template.

  **Know what the detection actually produces before you filter on it.** A page type
  is derived from the URL path, and today it only collapses into a template
  (`/products/:slug`) where the path has a repeated shape. A path that occurs once
  becomes its own type. The gate site produced **196 types over 551 pages**: four
  real templates and about 170 singletons — and `(untyped)` occurred **zero** times,
  so the bucket this file and the checklist both tell you to report may simply not
  exist on a given crawl. Say that it was empty rather than inventing one.

  Practical consequence: the cohort ids are not guessable, so discover them first —
  one `metrics_get` scoped pass or a `pages_query` census — and filter on the ids you
  saw. Where the per-template breakdown the checklist asks for (CHECK-35 / 36 / 37:
  products, collections, blog, info pages, separately) cannot be produced from those
  ids, group by first path segment and SAY SO in `notes`. Both halves of this —
  singleton types, and the missing `(untyped)` bucket — are recorded on the backlog
  as the `derivePageType` heuristics item; they are engine behaviour to work around
  today, not something to fix inside an audit.
- **A refusal names its field.** An unrecognised `severity`, `checkId`, `ruleId`,
  `category` or `pageType` is refused rather than answered with an unfiltered listing.
  Read the message; do not retry with a guess.
- **Large lists go to a file.** `export_crawl` writes `issues`, `pages` or `metrics`
  as gzipped JSONL and answers `{dataset, path, rows, bytes}`. Use it when you need
  every row; put the path in the findings file, not the rows.

### 2.3 Order of the walk

Follow the checklist's own sections — they group the calls naturally:

| Section | Checks | Mostly answered by |
|---------|--------|--------------------|
| Pre-Crawl | 01, 02 | render diff rules + `render.coverage` |
| 1. Crawlability & Robots | 03-05 | robots rules; browser for the file's contents |
| 2. Sitemaps | 06-09 | sitemap rules + `sitemap.structure` |
| 3. Redirects & Errors | 10-13 | redirect rules + `redirect.volume`, status rules |
| 4. Host & Protocol | 14-15 | host-probe rules |
| 5. Canonicals & Indexability | 16-21 | canonical + indexability rules |
| 6. Pagination | 22-23 | pagination rules; browser for JS-only controls |
| 7. Hreflang | 24-26 | hreflang rules + `hreflang.coverage` |
| 8. URL Parameters | 27-30 | `url.param-volumes` + URL hygiene rules |
| 9. Internal Linking | 31-34 | link metrics + orphan/nav rules |
| 10. On-Page SEO | 35-40 | on-page and content rules (38 is Phase 3) |
| 11. Structured Data | 43-46 | schema rules; browser for the opportunity matrix |

### 2.4 What the engine does not measure

Several checks ask for a number no rule produces. The checklist says so at each one.
Record those as NOT MEASURED in `notes` — never substitute a nearby number:

- total redirect **inlinks** (CHECK-10) — `redirect.volume` counts redirecting URLs;
- duplicate titles and duplicate meta descriptions (CHECK-35, CHECK-36);
- H1 **text** (CHECK-37) — the rules count H1s, they do not read them;
- image weight and format (CHECK-49); caching, compression and protocol (CHECK-50);
- Core Web Vitals (CHECK-47) — the engine measures response time and nothing else;
- GSC-only orphans (CHECK-32, CHECK-33b) — by definition outside a crawl.

**And one number that is measured, but does not measure what its name suggests.**
`depth` — the `structure.depth-distribution` metric, `pages_query`'s `depth`, and
CHECK-31 — is **discovery depth: hops from a seed**. Every sitemap URL is a seed, so
on a site whose sitemap covers the estate, pages with no HTML link path whatsoever sit
at depth 0 beside the home page. The gate site read 437 of 443 indexable pages at
depth 0 while the median page had **zero** inbound internal links: read literally,
CHECK-31 passes on a site where half the estate is unreachable by clicking.

So: when depth-0 is dominated by sitemap discovery — compare `discoveredVia` in a
`pages_query` census against the depth histogram — do not report site depth from that
metric. Rebuild reachability instead, from `links.orphan` (pages with no inbound
internal link) and `inlinks.sources-by-type` (which templates link to which), and
record CHECK-31 as passing on its stated criteria while NOT MEASURED on its intent,
with both halves in `notes`. CHECK-33b's "sitemap only (no depth)" tier is empty by
the same construction and needs the same rebuild. Click-depth as a field of its own is
on the backlog.

---

## Phase 3 — the agent checks

Everything left is yours. Three of them sit inside the crawl-derived range and the
rest are the browser, analytics and judgement sections.

### 3.1 The three judgement checks

- **CHECK-38 — content quality and intent match.** Two metrics supply evidence and no
  verdict: `content.metrics-by-type` (word-count distribution per template) and
  `content.template-similarity` (how alike a template's pages are). Quote both, then
  do the work: five page types plus three to five blog articles, read rather than
  skimmed. A metric is not an opinion about quality and must not be reported as one.
- **CHECK-41 — E-E-A-T.** No rule of any kind claims it, and no metric evidences it.
  The browser work in the checklist IS the check. Record concrete observations —
  which About page, which author bios, which policy pages — not a score.
- **CHECK-42 — out-of-stock handling.** Same shape: `content.soft-404` is context if
  it fires; the verdict comes from looking at an OOS product.

Their verdict in the findings file is `AGENT`, with `notes` carrying what you found.
`AGENT` means the work was done and the judgement is recorded — it is not a polite
SKIP, and a bare `AGENT` with empty notes is a check nobody did.

**With no browser, CHECK-41 and CHECK-42 are `SKIP`, not `AGENT`.** Both are entirely
browser work: no rule claims them, `issues_list` refuses their check ids, and without
a browser there is nothing to have looked at. `AGENT` would assert that the work was
done. Record `verdict: "SKIP"` with `notes` naming the missing browser MCP server and
what it blocked — the same disposition as §3.3's browser sections, and the one the
Phase 6 gate's auditor arrived at by following this file's own honesty rule against
this paragraph's earlier wording.

### 3.2 Hybrid checks: the engine half and the deciding half

Eleven of the in-scope checks are `Engine + DevTools` (03, 05, 22, 29, 30, 37, 39, 43,
44, 45, 46): the engine answers part of the question and a browser, GSC or Ahrefs
answers another part. Route them the same way every time, because a verdict that
depends on who ran the audit is not a verdict.

1. **Do the engine half and quote it.** Always. It is cheap and it is the part that
   scales past one page.
2. **Does the engine evidence resolve the check's own Evaluate criteria?** If yes,
   the verdict is the engine's — `PASS` or `FAIL` — and `notes` names every sub-step
   you did not perform, so the reader knows what the verdict does not cover.
3. **If the deciding criterion is one only the missing tool can answer**, the engine
   half cannot carry the verdict, and it downgrades by what is missing:
   - missing **judgement** (the evidence is in hand; nobody has weighed it) → `AGENT`,
     with the engine work quoted in `notes`;
   - missing **evidence** (the tool that would produce it was never available, so
     there was no work to do) → `SKIP`, naming the tool.

The distinction between the last two is the same one that separates MANUAL from SKIP
in the checklist: `AGENT` says a person looked, `SKIP` says nobody could. Never let a
half-answered hybrid check land on `PASS` — an engine half that passes is not the
check passing, and recording it as one is how a site gets a clean bill of health for a
question nothing asked.

This policy came out of the Phase 6 gate, where the auditor had to invent it mid-walk
because the skill routed only the pure cases. It is written down so the next audit
lands where that one did.

### 3.3 The browser and platform sections

Sections 12 (Performance & CWV), 13 (GEO / AI Visibility) and 14 (Shopify-specific)
are agent work with engine support where the checklist names it — CHECK-49, CHECK-50
and CHECK-52 have rules; CHECK-65 to CHECK-70 read the pages listing and the canonical
and content findings.

Before the first browser check, confirm the browser MCP server answers. If it does
not: name the checks it blocks, tell the user, and wait. Do not substitute a plain
HTTP fetch for a check that needs a rendered page — a fetch has no JavaScript, no
console and no layout, and a check answered from one is answered wrongly. If the user
says to continue without a browser, those checks are SKIP with the tool named.

### 3.4 Cross-reading

Several findings only mean something together, and this is where the audit stops being
a list:

- CHECK-01 (client-side rendering) with CHECK-33b (product discovery) and CHECK-31
  (depth): a JS-only product grid is why products have no depth and why the sitemap is
  carrying discovery on its own.
- CHECK-03 (robots patterns) with CHECK-27/CHECK-29 (parameter volumes): what gets
  through the robots rules is what the crawl surface is made of.
- CHECK-39 (near-duplicates) with CHECK-78 (cannibalisation from GSC): duplicate pairs
  and cannibalising query groups are usually the same pages seen twice.
- CHECK-73 (top pages) with everything: a fault on a page that earns is a different
  finding from the same fault on one that does not.

---

## Phase 4 — the findings file

Write ONE JSON file: `ariadne-findings.json` in the audit's working directory.

**This shape is an interface, not an example.** The `ariadne-report` and
`ariadne-action-plan` skills read it verbatim; a field renamed here is a deliverable
broken there.

```json
{
  "schema": "ariadne-findings/1",
  "generatedAt": "2026-08-27T17:42:11.000Z",
  "site": {
    "siteUrl": "https://example.com",
    "client": "Example Ltd"
  },
  "crawl": {
    "crawlId": "crawl_0b316718-636a-42c9-abbb-738c46b77db6",
    "siteUrl": "https://example.com",
    "status": "finished",
    "startedAt": "2026-08-27T09:12:04.100Z",
    "finishedAt": "2026-08-27T10:48:55.902Z",
    "pagesCrawled": 4821,
    "renderPassCount": 1,
    "rulesetVersion": "0.4.0",
    "frontier": { "pending": 0, "leased": 0, "done": 4821, "failed": 3, "renderPending": 0 },
    "rulesRun": { "pagesScanned": 4821, "findings": 1902, "metrics": 855 },
    "render": { "rendered": 240, "failures": 2, "unrendered": 4581, "budget": 241, "truncated": false },
    "caveats": [
      "3 URLs failed to fetch; their checks are reported on 4818 pages, not 4821."
    ]
  },
  "checklist": {
    "path": "skills/ariadne-audit/checklist.md",
    "checksTotal": 82
  },
  "coverage": { "pass": 31, "fail": 24, "skip": 12, "agent": 15 },
  "checks": [
    {
      "checkId": "CHECK-07",
      "title": "Sitemap contains only indexable 200 URLs",
      "section": "2. Sitemaps",
      "priority": "High",
      "verdict": "FAIL",
      "severity": "warning",
      "owner": "engine",
      "notes": "128 of 4,102 sitemap URLs (3.1%) are non-indexable: 96 noindexed collection filters, 32 redirects to /collections/all.",
      "recommendation": "Regenerate the sitemap from indexable canonical URLs only; drop filtered collection URLs from it entirely.",
      "evidence": [
        {
          "kind": "finding",
          "tool": "issues_list",
          "args": { "crawlId": "crawl_0b31…", "checkId": "CHECK-07" },
          "ruleId": "sitemap.non-indexable",
          "severity": "warning",
          "count": 96,
          "sampleUrls": ["https://example.com/collections/x?filter.v.size=8"]
        },
        {
          "kind": "finding",
          "tool": "issue_urls",
          "args": { "crawlId": "crawl_0b31…", "ruleId": "sitemap.redirected" },
          "ruleId": "sitemap.redirected",
          "count": 32,
          "export": "/srv/ariadne/exports/crawl_0b31…-issues.jsonl.gz"
        },
        {
          "kind": "metric",
          "tool": "metrics_get",
          "args": { "crawlId": "crawl_0b31…", "metricId": "sitemap.structure" },
          "metricId": "sitemap.structure",
          "scope": "site",
          "scopeValue": "",
          "value": { "docs": 6, "totalUrls": 4102, "urlCapBreaches": 0, "entryCapReached": false, "oversizedDocsSkipped": 0 }
        }
      ]
    },
    {
      "checkId": "CHECK-41",
      "title": "E-E-A-T signals",
      "section": "10. On-Page SEO",
      "priority": "Medium",
      "verdict": "AGENT",
      "severity": "warning",
      "owner": "agent",
      "notes": "About page names no people and carries no credentials; 4 of 5 articles reviewed have no byline; no editorial policy page. Trust signals are present on PDPs (returns, contact, reviews).",
      "recommendation": "Add author identities and bios to editorial content; publish an editorial standards page; surface the company's people on the About page.",
      "evidence": [
        {
          "kind": "observation",
          "source": "browser",
          "summary": "Navigated /about and 5 articles; extracted in-content links and byline elements.",
          "urls": ["https://example.com/about", "https://example.com/blogs/journal/x"]
        }
      ]
    },
    {
      "checkId": "CHECK-80",
      "title": "AI citations and brand share of voice",
      "section": "15. Backlinks & Brand Authority (Ahrefs)",
      "priority": "High",
      "verdict": "SKIP",
      "severity": null,
      "owner": "analytics",
      "notes": "Ahrefs Brand Radar is not available on this account; no AI citation data was retrieved.",
      "recommendation": null,
      "evidence": [
        { "kind": "observation", "source": "ahrefs", "summary": "brand-radar-* tools not available on the connected subscription." }
      ]
    }
  ]
}
```

### Field rules

- **`checks` carries every check in the checklist, exactly once.** A check with no
  entry is indistinguishable from a check nobody ran. 82 entries, always.
- **`verdict`** is one of `PASS`, `FAIL`, `SKIP`, `AGENT`. The checklist's six
  statuses map onto them (see its Status Definitions table): WARN is a `FAIL` at a
  lower `severity`, N/A is a `SKIP` whose notes say why it does not apply, MANUAL is
  `AGENT`.
- **`severity`** is `critical`, `warning`, `info` or `null`. Null for `PASS` and
  `SKIP`. For `FAIL` it starts as the rule's severity and is yours to adjust in
  context — say so in `notes` when you do.
- **`owner`** is `engine` (a rule or metric answered it), `agent` (judgement or
  browser work) or `analytics` (GSC / GA4 / Ahrefs).
- **`notes`** is required for `FAIL`, `SKIP` and `AGENT`, and is where the human
  sentence lives. For `SKIP` it must name what was unavailable.
- **`recommendation`** is required for `FAIL` and `AGENT` where a fix exists, `null`
  otherwise. It is the fix in the client's terms — the action-plan skill turns these
  into work items.
- **`evidence`** is a non-empty array for every check, including passes. Three kinds:
  - `{"kind": "finding", "tool", "args", "ruleId", "severity", "count", "sampleUrls", "export"}`
    — a rule's output. `export` is optional and holds the path from `export_crawl`
    when the full list was written to disk.
  - `{"kind": "metric", "tool", "args", "metricId", "scope", "scopeValue", "value"}`
    — a metric's row, with `value` copied verbatim.
  - `{"kind": "observation", "source", "summary", "urls", "detail"}` — everything the
    agent saw: `source` is `browser`, `gsc`, `ga4`, `ahrefs` or `manual`. `urls` and
    `detail` are optional.
  A PASS reached because a rule found nothing carries a `finding` entry with
  `count: 0` and the `args` that were asked, so the reader can re-run the query.
- **`args` reproduces the call.** The point is that anybody can repeat it and get the
  same answer.
- **`crawl.rulesRun`** copies the `crawl_rules` summary's scalars — `pagesScanned`,
  `findings`, `metrics`. The surface returns no `elapsedMs`; do not invent one, and do
  not leave a null in its place.
- **`crawl.caveats`** is where the evidence's limits go: a page cap reached, a render
  pass that covered a fraction, URLs that failed to fetch, a crawl that ended
  `cancelled`. Empty array when there are none — never absent.
- **`coverage`** counts the verdicts. It must sum to `checklist.checksTotal`.

### Before you hand it over

- Every check present, every `notes` written for the verdicts that need one.
- No verdict resting on an empty listing without the `crawl_rules` summary behind it.
- No engine-claimed check whose verdict came from a browser instead.
- The counts in `coverage` add up.

Then say, in the conversation: the crawl's shape, the top few problems in plain
language, and where the findings file is. The report and action-plan skills take it
from there.

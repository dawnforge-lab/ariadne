# Build plan: backend crawl and audit engine

Companion to `crawl-audit-engine-spec.md` (design and rule map). This file is
the executable plan: provenance, a file-level lift manifest, phased tasks with
acceptance gates, and guardrails.

## How an agent should use this plan

1. Read `crawl-audit-engine-spec.md` first for the data contract and rule map.
2. Work phases in order. Each phase has a **Gate**: a measurable condition
   that must hold before the next phase starts.
3. Task ids (`P1-T3`) are stable. Reference them in commits.
4. **Read any file in full before absorbing it.** If you would not be able to
   debug it at 2am, write your own instead — see the governing rule in §1.
5. Every absorbed file gets a provenance header and an entry in
   `THIRD_PARTY_NOTICES.md` (§3). Licence obligation, not a sync mechanism.
6. When a check cannot be satisfied by a rule, mark it `AGENT` in the registry
   rather than writing a rule that always passes. See guardrails, §6.

---

## 1. Three categories, only one of which is a dependency

Once code is lifted we are its maintainers. There is no upstream to inherit
fixes from — nobody backports a Go bug fix across a TypeScript port. So the
categories must not be blurred:

**A. Real dependencies** — npm packages, upgraded on a normal cadence. Kept
small and boring on purpose: `undici`, `htmlparser2`, `robots-parser`,
`fast-xml-parser`, `playwright`, `pg`/`drizzle`. `cheerio` in devDependencies
as a test oracle. **No crawl framework** — see spec §1.

**B. One-time source material** — absorbed once, owned forever, never synced.
Two code files, one body of text, one set of test fixtures. Upstream becomes
irrelevant the moment it lands. The MIT notice is a static legal obligation,
not a maintenance relationship.

**C. Reference reading** — read once, write our own, never look again. Zero
ongoing cost. This is where most of the value actually is: the threshold
choices, the check taxonomy, the reasons behind the caps.

### The governing rule

**Lift nothing you have not read and could not have written.** What makes a
fork unmaintainable is carrying code you do not understand. Total owned code
for this engine is roughly 3–4k lines: small enough for one person to hold in
their head, which is the whole point.

Applying that rule cuts the previous manifest by about three quarters. What
survives is ~700 lines of borrowed code, all of it readable in an afternoon.

### Sources

| Ref | Repo | Licence | Category | Role |
|---|---|---|---|---|
| **OS** | [`every-app/open-seo`](https://github.com/every-app/open-seo) | MIT (© 2026 Ben Senescu) | B + C | Two files worth taking (extractor, SSRF policy). Everything else is reference. |
| **BAD** | [`every-app/open-seo`](https://github.com/every-app/open-seo), `badseo/` | MIT (same repo) | B | Fixture page content. We write our own harness. |
| **SN** | [`StJudeWasHere/seonaut`](https://github.com/stjudewashere/seonaut) | MIT | B (text) + C | Issue copy is a text lift. The Go reporters are reference, not a port. |
| **SM** | [`seo-skills/seo-audit-skill`](https://github.com/seo-skills/seo-audit-skill) | MIT | C | Coverage checklist only. |
| **CHK** | `~/.claude/skills/sf-audit/checklist.md` | internal | spec | 82 checks, 47 crawl-derived. The authority. |

### Do not use

| Repo | Reason |
|---|---|
| `Amaculus/screaming-frog-api` | **No licence file.** All rights reserved. Do not copy, do not depend on it. |
| `viasite/site-audit-seo` | AGPL-3.0. Network copyleft. |
| `mascanho/RustySEO`, `beb7/gflare-tk`, `nazuke/SEOMacroscope` | GPL-3.0. Do not read these for implementation guidance either — reimplementing from copyleft source is a tainting risk. Feature ideas from their public docs and UI are fine. |
| Screaming Frog | Proprietary. Nothing lifted. Do not decompile or inspect `.seospiderconfig` internals for this build. |

---

## 2. Lift manifest

Deliberately short. Everything not listed here is category C: read it, learn
from it, write your own.

### B — Code to absorb (two files, ~450 lines)

| Source | Destination | Why this one earns it |
|---|---|---|
| OS `src/server/lib/audit/page-analyzer.ts` + its `.test.ts` | `src/crawl/parse/page-analyzer.ts` | A correct streaming extractor is a week of subtle edge cases: `<title>` inside `<svg>`, `noscript` handling matching parse5, implicitly-closed nested anchors, body-vs-fallback text scoping, `alt=""` versus absent alt, per-page collection caps. The tests assert parity against cheerio, so you can verify your version rather than trust it. Read it fully, then own it. |
| OS `src/server/lib/audit/url-policy.ts` + its `.test.ts` | `src/crawl/url-policy.ts` | Security code with non-obvious cases: IPv4-mapped IPv6, DoH resolution for the start URL, per-hop revalidation so a redirect cannot smuggle the crawler somewhere you could not point it directly. ~200 readable lines. Writing this fresh means rediscovering the same bypasses. |

Take `url-utils.ts` too if you want (`normalizeUrl`, `isSameOrigin`,
`canonicalUrlKey`, `detectUrlTemplate`) — it is small and trivially auditable,
but writing it yourself is an hour's work either way. `detectUrlTemplate` is
what derives `page_type`, so make sure whatever you use handles the numeric and
slug segment cases.

### B — Text to absorb (one lift, zero maintenance)

| Source | Destination | Notes |
|---|---|---|
| SN `translations/translation.en.yaml` | `src/rules/registry/copy/` | **Do this first.** 69 `ERROR_*` keys, each a title plus a `_DESC` explanation. Text does not rot, needs no upstream fixes, and is the single highest-value item in the plan. |
| OS `src/shared/audit-issues.ts` | same | 27 descriptors with severity, explanation and howToFix. Merge with SN's, keep the richer text per issue. |

### B — Test fixtures to absorb

| Source | Destination | Notes |
|---|---|---|
| BAD `badseo/src/fixtures/*.ts` (page content) | `test/fixtures/` | ~30 pages each breaking one rule, with `expectedIssues[]` declared. You need fixtures regardless; these already exist and are correct. |
| BAD `badseo/src/routes/robots[.]txt.ts`, `sitemap[.]xml.ts` | fixture app | So robots and sitemap rules have something to bite on. |

Write your own harness and your own `Fixture` type — the contract is about
twenty lines (`path`, `category`, `name`, `expectedIssues[]`, `handler`) and
the upstream one is coupled to TanStack Start. Take the content, not the
plumbing.

New fixtures to author, since nothing upstream covers them: hreflang return
links, invalid hreflang code, missing x-default, canonical to 404, canonical to
noindex, cross-domain canonical, canonical plus noindex, pagination without rel
next, paginated canonical to page 1, soft 404, trailing-slash and case
variants, tracking parameters on internal links, sitemap containing a 301, URL
crawled but absent from sitemap, product schema missing required fields,
missing BreadcrumbList, security header absences, oversized image, `img`
without dimensions, insecure form, duplicated element id, missing viewport.

### C — Reference reading

Read these once, extract the decisions, write your own code. **Do not port
file-by-file.** The value is the thresholds and the reasoning, not the
implementation.

| Source | What to extract |
|---|---|
| OS `issues/page-reporters.ts` | The 27-issue taxonomy and its thresholds (title 10–60, meta 70–160, thin content 150 words, slow response 1500ms, deep page 5). The code is ~150 lines of if-statements over a record; write your own so the thresholds are yours to tune. |
| OS `issues/multipage-checks.ts` | The redirect chain-head walking algorithm, including the headless-cycle pass (a↔b where every member is also a target, which a naive walk never reaches). Genuinely non-obvious. Reimplement as SQL. |
| OS `site-audit-workflow-helpers.ts` | Fetch semantics as decisions: manual redirects so every hop is a row, 1MiB body cap, and the bot-challenge classification table (`cf-mitigated` header, 401/403/429, 503 plus body markers). Copy the classification table's *contents*; write the fetch yourself against undici. |
| OS `discovery.ts` | The caps and why: 500KB robots.txt (RFC 9309 says parsers must handle 500KB and may ignore beyond, which is what Google does), 10MB per sitemap doc, depth 3, 300 docs, oversized shards skipped whole. |
| OS `crawl-window.ts` | Adaptive concurrency policy: shrink on errors/blocks/slow, grow only on a clean full-size fast batch, and cap by an in-flight byte budget. The byte budget is the part that actually prevents OOM. |
| OS `AuditScratchpad.ts` | Frontier leasing and idempotency semantics, if you later want resumable crawls. Postgres makes most of it easier. |
| SN `internal/issues/page/*.go` | **The check definitions, not the Go.** 20 files: `canonical`, `indexability`, `hreflangs`, `language`, `pagination`, `url`, `security`, `form`, `images`, `viewport`, `scheme`, `ttfb`, `timeout`, `depth`, `content`, `title`, `description`, `headings`, `links`, `status`. Read each, write down what it checks and its threshold, implement in our idiom. |
| SN `internal/issues/multipage/*.go` | `hreflang.go` (the return-link self-join — read carefully, it is the least obvious), `orphan.go`, `canonical.go`, `links.go`, `body.go`. |
| SM `docs/SEO-AUDIT-RULES.md` | Coverage checklist across 20 categories. Diff against our registry to find blind spots (i18n, security, legal, social, E-E-A-T, GEO). |
| SM `src/rules/define-rule.ts` | Load-time rule validation pattern: fail loudly on a malformed rule at startup. Good idea, ~40 lines, write our own. |
| SM `src/crawler/playwright-fetcher.ts` | Raw-versus-rendered comparison approach for the render pass. |

Do not lift SM implementations. Verified: `src/rules/links/orphan-pages.ts`
always passes, and `src/rules/links/broken-internal.ts` fetches every link
inside the rule.

## 3. Attribution

Licence obligation only. Not a sync mechanism — there is nothing to sync.

**P0-T1.** Create `THIRD_PARTY_NOTICES.md` with the full MIT licence text and
copyright lines for OS/BAD (© 2026 Ben Senescu), SN and SM, plus notices for
the npm dependencies. MIT requires the notice to travel with the code. Do this
before the first lift.

Each absorbed file gets a one-line header recording where it came from and at
which commit:

```ts
/**
 * Adapted from open-seo (MIT), src/server/lib/audit/page-analyzer.ts @ <sha>.
 * Changes: <what and why>.
 */
```

The sha is an audit trail for the licence and a courtesy to the next reader.
It is not a promise to track upstream.
## 4. Phases

### Phase 0 — Groundwork
- **P0-T1** `THIRD_PARTY_NOTICES.md` (§3).
- **P0-T2** Repo skeleton: `src/crawl`, `src/rules/{page,query,metric}`, `src/rules/registry`, `src/db`, `src/report`, `test/fixtures`.
- **P0-T3** Postgres schema from spec §2. Migrations, not hand-applied SQL.
- **P0-T4** Rule registry types from spec §3, including `checkIds` and `rulesetVersion`. Load-time validation in the shape of SM's `define-rule.ts`.
- **Gate:** schema migrates clean, registry loads zero rules without error, notices file complete.

### Phase 1 — Crawl loop
- **P1-T1** Absorb `url-policy` (+ tests) from OS. Read it fully first; you now own it.
- **P1-T2** Absorb `page-analyzer` (+ parity tests) from OS. Green before extending.
- **P1-T3** Extend the analyser: `rel_next`/`rel_prev`, `dom_size`, text ratio, JSON-LD `@type` plus raw object capture, hreflang code-and-href pairs, simhash. Extend the parity tests alongside.
- **P1-T4** Write `fetch-page` against undici. Decisions taken from OS: manual redirects so every hop is a row, 1MiB streaming body cap, bot-challenge classification table, `Link: rel=canonical` header parsing.
- **P1-T5** Write `discovery`: robots.txt and sitemaps via `robots-parser` and `fast-xml-parser`, with OS's caps (500KB robots, 10MB per doc, depth 3, 300 docs). Persist to `sitemap_urls`.
- **P1-T6** Write the crawl loop: `frontier` table in Postgres (url primary key, state pending/leased/done, depth, discovered_via), a worker pool bounded by a semaphore, same-origin policy, `url-policy` on every discovered URL, graceful shutdown that releases leases. ~400 lines. No crawl framework.
- **P1-T7** Write the politeness governor, policy taken from OS `crawl-window.ts`: shrink the window on errors/blocks/slow responses, grow only on a clean full-size fast batch, and cap it by an in-flight byte budget. The byte budget is the part that prevents OOM.
- **P1-T8** Persistence: batched inserts into `pages`, `links`, `hreflang`, `structured_data`. Never accumulate results in memory.
- **P1-T9** Derive and store `page_type` via `detectUrlTemplate` plus optional client path patterns.
- **Gate:** crawl a 50k-page site. Peak RSS under 512MB, `links` row count consistent with page count, no unbounded arrays in a heap snapshot. **Report the actual RSS figure.**

### Phase 2 — Page rules
- **P2-T1** Write the 27 page rules using OS's taxonomy and thresholds as the reference. One file per category, each wired to the registry with `checkIds`.
- **P2-T2** Absorb the copy: SN's `translation.en.yaml` (69 issues) plus OS's `audit-issues.ts` descriptors (27). Reconcile overlaps, keep the richer text per issue, store as `{title, explanation, howToFix}` on each registry entry.
- **P2-T3** Work through SN's 20 page reporters as reference. For each: note what it checks and its threshold, then implement in our idiom. Priority order — canonical, indexability, hreflangs, pagination, url, then the bonus set (security, form, images, viewport, ttfb).
- **P2-T4** Absorb BAD's fixture page content. Write our own `Fixture` type and harness (~20 line contract).
- **P2-T5** Author the new fixtures listed in §2 for every rule added in P2-T3.
- **Gate:** fixture harness green — every registered page rule fires on at least one fixture, and no rule fires on the clean control page. CI fails on an unclaimed rule.

### Phase 3 — Query rules
- **P3-T1** Write the duplicate and redirect queries in SQL. Take the chain-head walking algorithm from OS `multipage-checks.ts`, including its headless-cycle second pass.
- **P3-T2** Broken internal links, orphan pages (gated on crawl completeness), canonical target status, hreflang return links, hreflang target status. SN's `multipage/hreflang.go` is the reference for the return-link self-join.
- **P3-T3** Sitemap joins: non-200 in sitemap, non-indexable in sitemap, crawled-but-absent, shard structure.
- **P3-T4** URL hygiene: case and trailing-slash variant groups, parameter inventory, tracking parameters on internal links.
- **P3-T5** Soft-404 detection: 200 plus thin plus signal phrases plus template similarity to a known 404.
- **P3-T6** Near-duplicate pairs from simhash banding, with similarity buckets and a page-type pair matrix.
- **P3-T7** Structured data queries: types-by-page-type matrix, product field completeness, BreadcrumbList presence, review markup.
- **P3-T8** Host and protocol probe step (pre-crawl, not a crawl output): four host variants plus client-supplied legacy hosts, record hop chains.
- **Gate:** every one of the 47 crawl-derived `CHECK-NN` ids is claimed by a rule or explicitly marked `AGENT` in the registry. Coverage query in CI.

### Phase 4 — Metric rules
- **P4-T1** Inlinks distribution: min, median, mean, max, bottom 20, top 20, averages by page type (CHECK-33).
- **P4-T2** Depth distribution by page type (CHECK-31).
- **P4-T3** Inlink sources by source page type (CHECK-33b).
- **P4-T4** Content metrics by page type: word count, text ratio, boilerplate share (CHECK-38 evidence).
- **P4-T5** Hreflang coverage percentage overall and by page type (CHECK-24).
- **P4-T6** Facet and parameter volume metrics (CHECK-29 evidence).
- **P4-T7** Redirect volume ratio (CHECK-10).
- **Gate:** each metric renders as a table an agent can quote directly, with no post-processing needed to answer the checklist's "Record:" lines.

### Phase 5 — Render pass
- **P5-T1** Suspicion filter: low words with large HTML, zero links, empty title with large body, framework markers.
- **P5-T2** Playwright pass over the sample plus suspects, reusing the frontier table with a `render_pending` state; populate `rendered_*`.
- **P5-T3** Diff rules: CSR-dependent content, nav absent from raw HTML, JS redirects, filters as JS (CHECK-01, 02, 10, 34).
- **Gate:** render pass stays under 5% of URLs on a real site and the four checks are answered from stored data.

### Phase 6 — Agent surface
- **P6-T1** MCP tools mirroring the existing SF skill vocabulary so current workflows keep working: run crawl, crawl status, list issues (filterable by severity, check id, page type), list pages, get metrics, export.
- **P6-T2** Domain allowlist on crawl-triggering tools, per `screaming-frog-mcp`'s `SF_ALLOWED_DOMAINS` pattern. An unattended agent must not be able to crawl arbitrary hosts.
- **P6-T3** Keep responses filtered and paginated. Never return a full export inline.
- **Gate:** an agent completes sections 1 to 11 of the checklist against a real site using only these tools.

### Phase 7 — Reports
- **P7-T1** Shape the issues query output to what `sf-action-plan` expects per tab: issue, severity, affected URLs, context, fix.
- **P7-T2** Feed `sf-report` and the presentation skills from `issues` plus `metrics`.
- **Gate:** one real client site produces a full deliverable set with no manual data wrangling.

---

## 5. Milestone worth defending

All 47 crawl-derived checks claimed, fixture harness green in CI, a 50k-page
crawl under 512MB, and one real client site audited end to end into the
existing report and action-plan output.

---

## 6. Guardrails

- **Never write a rule that always passes** to make a count look good. If it
  needs data you do not have, mark the check `AGENT` or leave it unclaimed and
  let CI say so. This is the specific failure found in SM's `orphan-pages.ts`.
- **Never fetch inside a rule.** Rules read the database. SM's
  `broken-internal.ts` fetches per link; that pattern is why it does not scale
  and it is impolite to the target site.
- **Never load the `links` table into memory.** It is the largest table and the
  reason SF needs 12GB. Every link question is a query.
- **Never build a DOM on the hot path.** Streaming tokenizer only. cheerio may
  stay in devDependencies as a parity oracle in tests, as OS does.
- **Do not skip `url-policy`.** SSRF is a real exposure the moment a URL comes
  from a client or an agent.
- **Do not read GPL or AGPL sources** for implementation guidance (§1).
- **Do not depend on `Amaculus/screaming-frog-api`** — unlicensed.
- **The memory contract is a hard requirement, not a target.** If the 50k-page
  crawl peaks above 512MB, the cause is an unbounded structure somewhere; find
  it with a heap snapshot rather than raising the limit.

---

## 7. Known gaps carried out of Phase 1

Phase 1 shipped with these open. Evidence and measurements are in
`docs/gates/phase-1.md`; this section is the tracking record so Phase 2 sees
them.

### Hard-kill durability (CLOSED in Phase 5, task 1 for `pages`; child-table rows remain exposed)

The loop marked a frontier row `done` once `PageWriter.addPage` had *buffered*
the page row, and the insert happened when the buffer filled (`batchSize` 100).
A process killed outright (SIGKILL, OOM, power) lost up to `batchSize - 1`
rows per table while the frontier already recorded those URLs as finished, so a
resume did not re-fetch them. Every graceful path — abort, error, normal
finish — flushed first, so only a hard kill was exposed.

**Fixed** by the second of the two directions this section offered: the page
insert and the frontier completion share one transaction. `PageWriter` records
each buffered page row's frontier URL and `flushPages` calls the new batch
`completeUrls` inside `db.transaction`, so a URL is `done` only when its page
row has committed and a kill between the two costs a re-fetch rather than the
page. The loop no longer completes anything on the success path (`failUrl` is
untouched) and flushes the writer at the end of every leased batch, which keeps
a URL's completion inside the lease that authorised its fetch. Done before the
frontier's state machine grew `render_pending`, as this section asked.

**Residual, and it is not small.** The defect above was "up to `batchSize - 1`
rows **per table**", and only `pages` is fixed. `links`, `hreflang` and
`structured_data` are still written outside that transaction, so a kill between
the page commit and the child inserts loses up to one leased batch of child
rows for pages the frontier now marks `done`. That loss is *unrecoverable*
where the old one was not: the URL is finished, no resume re-fetches it, and a
page with no link rows is indistinguishable from a page that had none — a
silent false negative for every rule that counts child rows. Closing it means
moving the child inserts into the same transaction, which trades away the
property that a failing `links` insert must not destroy the page row.

### Before the first real-site crawl

Phase 1's gate ran against a local fixture server. Each of these bites on the
open internet and none is exercised by the gate:

- **`accept-encoding` / gzip in `fetch-page`**, with a cap on *decompressed*
  bytes as well as wire bytes (discovery already caps decompressed sitemap
  bytes; page fetch does not compress at all today).
- **Per-origin connection cap on the undici agent.** Politeness (rule 9) is
  currently paced by the host gate alone; nothing bounds concurrent sockets to
  one origin.
- **`allowPrivate` must not survive into persisted crawl config.** It is a
  test-only escape hatch: strip it when the config is stored, and require an
  explicit re-assertion on resume rather than replaying it from the row.
- **Verify the robots origin-variant fix against a real www/apex site.** The
  rewrite in `RobotsInfo.isAllowed` is covered by a fixture test only.
- **6to4 (`2002::/16`) and Teredo (`2001::/32`) exclusion** in url-policy's
  IPv6 global-unicast allowlist: both embed an IPv4 address that the
  `2000::/3` allowlist currently waves through.

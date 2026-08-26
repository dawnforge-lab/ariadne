# Ariadne Phase 3: Query Rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cross-page evidence layer — ~22 query rules over the crawl's tables (redirect chains, broken links, orphans, hreflang joins, sitemap mismatches, URL/host hygiene, soft-404s, near-duplicates, structured-data audits) claiming every crawl-derived check the current data can honestly answer, ending with the coverage pin shrunk to the 7 checks that structurally need Phase 4 metrics or Phase 5 rendering.

**Architecture:** Query rules are `(db, crawlId) => Promise<Finding[]>` — SQL joins and anti-joins, never fetches, never in-memory table loads (the four URL-resolution rules stream candidates by id-cursor in batches). Cross-page state the rules need but the crawl discards today (robots text, discovery outcome, a known-404 template, host-variant hop chains) is persisted by a small crawl-layer task first. Derived inventories (`url_params`, `structured_data.field_presence`) are computed by explicit derivation steps the runner invokes before query rules — derivations write inventory, rules write only `issues`.

**Tech Stack:** Existing stack (TypeScript strict/ESM, drizzle, Postgres 16 — `bit_count` and bigint bit-ops do the simhash work in SQL). No new dependencies (`robots-parser` is already a runtime dep and re-parses the stored robots text inside one rule).

**Spec:** `docs/crawl-audit-engine-spec.md` §4 rule map + `docs/crawl-audit-build-plan.md` §4 Phase 3 (P3-T1…T8), with three owner-approved amendments from the 2026-08-26 planning session: (1) **the P3 gate is amended** — the build plan's "all 47 claimed or AGENT" is unsatisfiable without fake rules, because CHECK-01/02/34 need Phase 5's render data and CHECK-08/29/33/33b are Phase 4 metric-kind; Phase 3 claims the 22 query-claimable checks and the coverage pin shrinks to exactly those 7, annotated in the registry (`RENDER_CHECKS`, `METRIC_PENDING_CHECKS`), emptying across P4/P5; (2) **soft-404 ships the full mechanism** (analyzer phrase flag + crawl-end known-404 probe + template simhash match); (3) **`hreflang.missing-x-default` upgrades from crawl-wide to per-declaration-set** (one finding per hreflang cluster lacking x-default, deduped by target-set hash).

## Global Constraints

- Node 22, TypeScript strict + isolatedModules; `npx tsc --noEmit` and `npm test` green at every commit. `DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne`; DB tests throw if unset.
- **Never fetch inside a rule. Never load the `links` table into memory.** Every cross-page question is SQL; where URL resolution forces JS (canonical targets), stream by id-cursor in batches of 500, never the whole table.
- **Never write a rule that always passes** — every new rule must fire on a fixture and stay silent on the clean control site-state; a rule that cannot run for a legitimate data-state reason (incomplete crawl, no sitemap) emits a visible site-scoped `info` finding saying so or is documented as data-gated — never a silent empty return that hides a skipped check.
- Migrations via drizzle-kit only (the drop+add interactive prompt workaround from Phase 2 is documented in git history — additive-only migrations here shouldn't need it).
- All rule copy through `copyFor` (extend `ISSUE_COPY` — every new id needs an entry in the same commit, plain client-facing English, no overpromising); `checkIds` trace to the checklist; severity tone matches copy.
- Established patterns to reuse, not reinvent: `queryFinding(self, …)` (Task 1 adds it), the checkIds snapshot tests, the fixture `exact` mechanism, the DATABASE_URL guard, provenance headers on anything absorbed (nothing is absorbed this phase — all reference reading).
- Commit after each green cycle, conventional messages ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Housekeeping — carried seeds, registry annotations, migration 0003 (rule-layer groundwork)

**Files:**
- Modify: `src/rules/registry/types.ts`, `src/rules/registry/registry.ts`, `src/rules/helpers.ts`, `src/rules/run.ts`, `src/rules/page/technical.ts`, `src/rules/query/hreflang.ts`, `src/rules/page/on-page.ts`, `src/rules/page/indexability.ts`, `src/rules/page/canonical.ts`, `src/db/schema.ts`, `docs/crawl-audit-engine-spec.md` (one word)
- Generated: `drizzle/0003_*.sql` (committed)
- Test: extend `test/rules/registry.test.ts`, `test/rules/run.test.ts`, `test/rules/technical.test.ts`, `test/db/schema.test.ts`

**Interfaces:**
- Produces (later tasks import these exact names): `RuleCategory` union type (`"on-page" | "canonical" | "indexability" | "hreflang" | "technical" | "crawl" | "redirects" | "links" | "sitemap" | "url" | "host" | "content" | "structured-data"`) constraining `RuleMeta.category`; `queryFinding(self: {id: string; severity: Severity}, f: {pageId: string | null; pageUrl: string | null; evidence: Record<string, unknown>; dedupeKey: string}): Finding` in `src/rules/helpers.ts` (query-rule twin of `finding` — severity single-sourced); `present(value: string | null): value is string` hoisted to helpers (delete the three copies); `RENDER_CHECKS = ["CHECK-01","CHECK-02","CHECK-34"]` and `METRIC_PENDING_CHECKS = ["CHECK-08","CHECK-29","CHECK-33","CHECK-33b"]` exported beside `AGENT_CHECKS`. Schema: `pages` gains index `pages_crawl_id` on `(crawl_id, id)` and column `has_soft404_phrases boolean notnull default false`; `crawls` gains `discovery_jsonb jsonb`, `host_probe_jsonb jsonb`, `notfound_probe_jsonb jsonb`; `issues` gains `ruleset_version text notnull default ''`.

- [ ] **Step 1: Failing tests.** Registry: `RENDER_CHECKS`/`METRIC_PENDING_CHECKS` exported, disjoint from `AGENT_CHECKS` and from each other, all ⊆ `CRAWL_CHECK_IDS`; `KINDS` drift-guard (`satisfies readonly AnyRule["kind"][]` — a type-level test is the compile itself; add the runtime disjointness asserts). Runner: unknown `crawlId` → rejects naming the crawl id (existence check against `crawls`). Technical: `structure.deep-page` now requires `isIndexable === true` (checklist: non-indexable pages' depth is irrelevant) — add the noindex-deep-page silent case. Schema test: new columns/index present.

- [ ] **Step 2: Implement.**
  - `types.ts`: `export type RuleCategory = …` (the 13-member union above); `RuleMeta.category: RuleCategory`.
  - `registry.ts`: the two new exported check lists; widen `unclaimedChecks` params to `readonly string[]`; `KINDS` as `["page","query","metric"] as const satisfies readonly AnyRule["kind"][]` (keep the widened `.includes` param); drop the redundant `(rule as {kind:string})` cast.
  - `helpers.ts`: hoist `present`; add `queryFinding` (returns `{ruleId: self.id, severity: self.severity, …f}`); update the three files that defined `present`/`declared` locally to import it.
  - `run.ts`: before the metric guard, `const crawl = await db.select(...).from(crawls).where(eq(crawls.id, crawlId)); if (crawl.length === 0) throw new Error(\`no such crawl '\${crawlId}'\`);` and stamp `rulesetVersion: RULESET_VERSION` on every inserted issues row.
  - `technical.ts`: `structure.deep-page` adds `p.isIndexable === true`; update the copy entry's wording if it implied all pages; update `/deep/*` fixture `expectedIssues` if affected (rungs are indexable — unchanged, verify).
  - `hreflang.ts`: add the "form only; no ISO membership check — a well-formed but nonexistent code passes" comment clause.
  - `schema.ts`: the new columns + index; `npm run db:generate` → 0003, `db:migrate`.
  - Spec §4 CHECK-40 row: `content.lorem-ipsum` → delete (the row already names `content.placeholder`).

- [ ] **Step 3: Full suite + typecheck green** (the category union will surface any existing category typo as a compile error — fix by correcting the string, never by widening the union).

- [ ] **Step 4: Commit** — `feat: phase 3 groundwork — category union, queryFinding, check annotations, migration 0003`

---

### Task 2: Crawl-layer prerequisites — discovery persistence, known-404 probe, soft-404 phrases, host probe

**Files:**
- Modify: `src/crawl/loop.ts`, `src/crawl/parse/page-analyzer.ts`, `src/crawl/persist.ts` (one field)
- Create: `src/crawl/host-probe.ts`
- Test: extend `test/crawl/loop.test.ts`, `test/crawl/analyzer-extensions.test.ts`, `test/crawl/persist.test.ts`; create `test/crawl/host-probe.test.ts`

**Interfaces:**
- Produces:
  - `crawls.discovery_jsonb` written by `runCrawl` after `discover()`: `{ robots: { outcome, crawlDelaySec, note, raw: string | null }, sitemapSources: string[], truncation, docsFetched }` — `raw` is the robots.txt text (already capped at 500KB by discovery; store verbatim, null when absent/unreachable).
  - `crawls.notfound_probe_jsonb` written at crawl end (after the main loop, before `closeCrawl`, through `gate.acquire` like any fetch): `{ probeUrl, statusCode, fetchClass, wordCount, simhash: string | null }` — probe URL `${origin}/__ariadne-404-probe-${randomUUID()}`; when the response is 200 HTML, run `analyzePage` and store `String(BigInt.asIntN(64, analysis.simhash))` + wordCount (that IS the soft-404 site signature); skipped (null) when robots-unreachable-disallow or zero pages crawled.
  - `PageAnalysis.hasSoft404Phrases: boolean` → `pages.has_soft404_phrases`. Phrase list (module const, case-insensitive, tested both directions): `"page not found"`, `"page cannot be found"`, `"page can't be found"`, `"404 error"`, `"error 404"`, `"404 not found"`, `"no longer available"`, `"nothing was found"`, `"this page doesn't exist"`, `"this page does not exist"`. Deliberately NOT bare `"404"` (product codes, years). Same visible-text accumulator as `hasLoremIpsum`, same oracle treatment (derived from `bodyText` → `EXTENSION_FIELDS`, documented).
  - `probeHostVariants(siteUrl, opts: { userAgent, allowPrivate?, lookup?, legacyHosts?: string[] }): Promise<HostProbeResult>` in `src/crawl/host-probe.ts`, `HostProbeResult = { variants: Array<{ start: string; hops: Array<{ url: string; statusCode: number | null; fetchClass: string; location: string | null }>; final: string | null }> }` — the four variants (`http/https × apex/www`; the www variant derived by adding/stripping the `www.` label) plus legacy hosts, each followed manually via `fetchPage` up to 5 hops (every hop already policy-checked by fetchPage; a `disallowed` verdict is recorded as that variant's terminal hop, not an error). Called by `runCrawl` before discovery when `config.probeHosts !== false` (default true; the 50k gate config may set false — 4 extra fetches are negligible either way); result → `crawls.host_probe_jsonb`. `CrawlConfig` gains `probeHosts?: boolean` and `legacyHosts?: string[]`.

- [ ] **Step 1: Failing tests.** Analyzer: phrase fires from visible text (`<p>Sorry — this page cannot be found.</p>`), not from script text, and `"born in 404 BC"`/`"room 404"` stay false. Persist: round-trip `hasSoft404Phrases`. Host-probe (fixture server): apex 200 + a `www.localhost` variant that redirects → chains recorded with hops; an https variant against an http-only server records `network_error` honestly. Loop: after `runCrawl` on the existing loop fixture, `crawls.discovery_jsonb.robots.raw` contains the fixture's robots text, and `notfound_probe_jsonb.statusCode === 404`; a fixture whose catch-all serves 200 (soft-404 site) records `statusCode: 200` + a simhash string.

- [ ] **Step 2: Implement** (analyzer change inside existing callbacks; loop changes are three well-marked insertions — probe before discovery, discovery persist after `discover`, 404-probe before `closeCrawl`; the 404 probe uses the same `fetchPage` opts and counts as no page row).

- [ ] **Step 3: Full suite + typecheck green** (the 50k gate scripts are NOT re-run this phase; their config gains nothing — `probeHosts` defaults on and costs 4 fetches).

- [ ] **Step 4: Commit** — `feat: crawl-layer evidence — discovery persistence, known-404 probe, soft-404 phrases, host probe (P3 prerequisites)`

---

### Task 3: Redirect + link-target rules (CHECK-10, 11, 19)

**Files:**
- Create: `src/rules/query/redirects.ts`, `src/rules/query/link-targets.ts`
- Modify: `src/rules/registry/copy/issue-copy.ts` (new entries), `src/rules/index.ts`
- Test: `test/rules/redirects-query.test.ts`, `test/rules/link-targets-query.test.ts` (DB tests — insert synthetic rows directly, per the established hreflang-query pattern)

**The rule table (implement every row; all `kind: "query"`, built with `defineRule` + `copyFor` + `queryFinding`):**

| id | checkIds | category | severity | fires when | evidence | dedupeKey |
|---|---|---|---|---|---|---|
| `redirect.chain` | CHECK-10 | redirects | warning | a redirect page whose target is itself a redirect (chain length ≥ 2 hops), reported once per chain HEAD (a redirect page nothing redirects to) | `chain: string[]` (urls in order), `length`, `finalStatus` | head url |
| `redirect.loop` | CHECK-10 | redirects | critical | following redirects revisits a url (incl. headless cycles: every member is itself a redirect target — the second pass) | `cycle: string[]` | sorted-cycle-urls hash |
| `links.broken-internal` | CHECK-11 | links | warning | an internal link whose target page row is `client_error` — one finding per TARGET | `targetUrl`, `statusCode`, `inlinkCount`, `sampleSources: string[]` (≤10) | target url |
| `canonical.non-200-target` | CHECK-19 | canonical | warning | effective canonical resolves to a crawled page that is not (`ok` + 200) | `canonical`, `targetStatus`, `targetFetchClass` | page url |
| `canonical.non-indexable-target` | CHECK-19 | canonical | warning | effective canonical resolves to a crawled page with `is_indexable` false | `canonical`, `targetRobotsMeta`, `targetXRobotsTag` | page url |

**Chain/loop SQL** — recursive CTE, depth-capped, then the headless-cycle pass:

```sql
-- heads: redirect pages that are not themselves a redirect target
WITH RECURSIVE heads AS (
  SELECT p.url FROM pages p
  WHERE p.crawl_id = $1 AND p.fetch_class = 'redirect'
    AND NOT EXISTS (SELECT 1 FROM pages q
      WHERE q.crawl_id = $1 AND q.fetch_class = 'redirect' AND q.redirect_url = p.url)
), walk AS (
  SELECT h.url AS head, p.url, p.redirect_url, 1 AS depth,
         ARRAY[p.url] AS chain, false AS is_cycle
  FROM heads h JOIN pages p ON p.crawl_id = $1 AND p.url = h.url
  UNION ALL
  SELECT w.head, p.url, p.redirect_url, w.depth + 1,
         w.chain || p.url, p.url = ANY(w.chain)
  FROM walk w JOIN pages p ON p.crawl_id = $1 AND p.url = w.redirect_url
  WHERE w.depth < 10 AND NOT w.is_cycle
)
SELECT head, chain || COALESCE(redirect_url, 'NULL') AS chain, depth, is_cycle
FROM walk w1 WHERE depth = (SELECT max(depth) FROM walk w2 WHERE w2.head = w1.head);
```

Chains with `depth >= 2` → `redirect.chain`; rows with `is_cycle` → `redirect.loop`. **Headless-cycle second pass** (a↔b where every member is a target — no head reaches them): redirect pages not reachable from any head (`fetch_class='redirect'` minus all urls appearing in any walk chain), walked the same way seeded from themselves; dedupe cycles by sorted member list. Canonical-target resolution is the batched-JS pattern: cursor pages with a canonical in batches of 500, resolve against page URL (reuse the resolution helper — export `resolveEffectiveCanonical(page)` from `src/rules/page/canonical.ts` instead of duplicating it), collect resolved targets, one `IN`-query per batch against `pages.url`, emit findings. Loop-safe memory: nothing outlives its batch.

- [ ] **Step 1: Failing DB tests** — synthetic rows: a 3-hop chain a→b→c→200; a 2-cycle d↔e with an external head f→d (cycle detected from the head walk); a HEADLESS pair g↔h (nothing points at them — must be found by the second pass, this is the mandatory regression test); broken-link rows (3 links → one 404 target: ONE finding, `inlinkCount: 3`); canonical→404 and canonical→noindex pairs; canonical→uncrawled url (no finding — target unknown is not evidence); clean rows fire nothing.
- [ ] **Step 2: Implement + copy entries; run to green.**
- [ ] **Step 3: Full suite + typecheck; commit** — `feat: redirect chain/loop, broken links, canonical target rules (P3-T1, P3-T2 part)`

---

### Task 4: Orphans, hreflang joins, pagination (CHECK-32, 24, 26, 22, 23, 25-upgrade)

**Files:**
- Create: `src/rules/query/link-graph.ts`, `src/rules/query/pagination.ts`
- Modify: `src/rules/query/hreflang.ts` (return-link + target rules + x-default upgrade), copy, index
- Test: `test/rules/link-graph-query.test.ts`, `test/rules/pagination-query.test.ts`, extend `test/rules/hreflang-query.test.ts`

| id | checkIds | category | severity | fires when | evidence | dedupeKey |
|---|---|---|---|---|---|---|
| `links.orphan` | CHECK-32 | links | warning | indexable 200 page with zero inbound `links` rows (`target_url = pages.url`), excluding the crawl seed — **gated**: when `frontier` has pending/failed rows or `pages_crawled >= maxPages`, emit instead ONE site-scoped `info` finding `links.orphan-check-skipped`-shaped (same rule id, `evidence.skipped: reason`) — a skipped check is visible, never silent | `inSitemap` (exists in sitemap_urls?), `discoveredVia` | page url |
| `hreflang.missing-return-link` | CHECK-24 | hreflang | warning | declaration P→T where T is crawled and T's hreflang rows do not include a target back to P (`hreflang.target_url` values are already absolute — persist resolves them) | `target`, `targetHasHreflang: boolean` | `${pageUrl}→${target}` |
| `hreflang.non-indexable-target` | CHECK-26 | hreflang | warning | declaration whose target page row is a redirect OR `is_indexable` false | `target`, `targetFetchClass`, `targetIndexable` | `${pageUrl}→${target}` |
| `hreflang.missing-x-default` | CHECK-25 | hreflang | info | **upgraded per-set**: a page's hreflang declaration set (≥2 declarations incl. itself) contains no `x-default` — ONE finding per distinct target-set (dedupe by sha256 of the sorted target list), pageUrl = the lexically-first member | `targets: string[]`, `setSize` | set hash |
| `pagination.next-target-uncrawled` | CHECK-22 | url | info | page with `rel_next` whose target (resolved against page url) has no `pages` row | `relNext` | page url |
| `pagination.next-not-linked` | CHECK-22 | url | warning | `rel_next` target crawled but has zero inbound `links` rows — paginated pages reachable only via the rel pattern, not HTML links | `relNext` | page url |
| `pagination.canonical-to-other` | CHECK-23 | url | info | page with `rel_prev` (page 2+) whose effective canonical points elsewhere (either strategy is defensible — the agent judges; self-canonical paginated pages fire nothing) | `canonical`, `relPrev` | page url |

The x-default upgrade REPLACES the site-scoped rule (same id, new shape — update the harness's site-scoped test: the finding now carries a pageUrl and lands on a path; the fixture pair `/authored/hreflang-no-xdefault` becomes the natural firing site, and its `expectedIssues` gains the id). `rel_next`/`rel_prev` resolution against page url happens in the batched-JS pattern from Task 3.

- [ ] **Step 1: Failing DB tests** per rule incl. the orphan gate (pending rows present → the skipped-finding, not silence), the return-link happy pair (silent) and broken pair (fires once per direction missing), the per-set x-default dedupe (two pages sharing one alternate set → ONE finding).
- [ ] **Step 2: Implement + copy; green. Step 3: Full suite; commit** — `feat: orphan, hreflang join, pagination rules; per-set x-default (P3-T2 part, CHECK-22..26, 32)`

---

### Task 5: Robots + sitemap rules (CHECK-03, 06, 07, 09)

**Files:**
- Create: `src/rules/query/sitemap.ts`, `src/rules/query/robots.ts`
- Modify: copy, index
- Test: `test/rules/sitemap-query.test.ts`, `test/rules/robots-query.test.ts`

| id | checkIds | category | severity | fires when | evidence | dedupeKey |
|---|---|---|---|---|---|---|
| `robots.missing` | CHECK-03 | crawl | info | `discovery_jsonb.robots.outcome === "absent"` — site-scoped | `note` | "site" |
| `robots.blocks-sitemap-urls` | CHECK-03 | crawl | warning | re-parse stored `robots.raw` with `robots-parser` (reading the DB, not fetching); sitemap_urls entries it disallows — one finding per url (cap 200, note truncation in a final site-scoped evidence row) | `url`, `matchedBy` (if derivable) | url |
| `sitemap.missing` | CHECK-06 | sitemap | warning | `discovery_jsonb.sitemapSources` empty — site-scoped | — | "site" |
| `sitemap.invalid` | CHECK-06 | sitemap | warning | `discovery_jsonb.truncation.failures` non-empty — site-scoped, one finding carrying the list | `failures` | "site" |
| `sitemap.non-200` | CHECK-07 | sitemap | warning | sitemap_urls ⋈ pages: crawled entry not (`ok` + 200) and not a redirect | `url`, `statusCode`, `fetchClass` | url |
| `sitemap.redirected` | CHECK-07 | sitemap | warning | joined entry `fetch_class = 'redirect'` | `url`, `redirectUrl` | url |
| `sitemap.non-indexable` | CHECK-07 | sitemap | warning | joined entry `is_indexable` false | `url`, `robotsMeta`, `xRobotsTag` | url |
| `sitemap.uncrawled` | CHECK-07 | sitemap | info | sitemap entry with no pages row (crawl cap/attempt exhaustion) — cap 200 | `url` | url |
| `pages.not-in-sitemap` | CHECK-09 | sitemap | info | indexable 200 page absent from sitemap_urls — **data-gated**: runs only when the crawl has ≥1 sitemap entry (no sitemap at all is CHECK-06's finding; document the gate in the rule comment) — cap 200 | `url` (as pageUrl) | page url |

- [ ] **Step 1: Failing DB tests** (synthetic sitemap_urls + pages rows + a crawls row with a hand-built discovery_jsonb; robots re-parse case uses a raw robots string with a `Disallow: /admin` and a sitemap entry under it).
- [ ] **Step 2: Implement + copy; green. Step 3: Full suite; commit** — `feat: robots + sitemap join rules (P3-T3, CHECK-03/06/07/09)`

---

### Task 6: URL + host hygiene, param derivation (CHECK-30, 27, 28, 14, 15)

**Files:**
- Create: `src/rules/query/url-hygiene.ts`, `src/rules/query/host.ts`, `src/rules/derive/url-params.ts`
- Modify: `src/rules/run.ts` (derivation phase), copy, index
- Test: `test/rules/url-hygiene-query.test.ts`, `test/rules/host-query.test.ts`, `test/rules/derive-url-params.test.ts`

**Derivation contract:** `deriveUrlParams(db: Db, crawlId: string): Promise<{ params: number }>` — SQL aggregation over `pages.url` query strings into `url_params` (`param_name`, `occurrence_count`, `sample_urls` capped at 5, `is_tracking` from the tracking list), idempotent (delete-then-insert per crawl). `runRules` gains an ordered derivation phase between page rules and query rules: `for (const derive of derivations) await derive(db, crawlId)` — derivations write inventory tables, rules stay read-only+issues. Tracking params list (module const): `utm_source, utm_medium, utm_campaign, utm_term, utm_content, gclid, gbraid, wbraid, fbclid, msclkid, mc_cid, mc_eid, igshid, twclid, ttclid`.

| id | checkIds | category | severity | fires when | evidence | dedupeKey |
|---|---|---|---|---|---|---|
| `url.normalisation-variants` | CHECK-30 | url | warning | `GROUP BY url_normalised HAVING count(DISTINCT url) > 1` — one finding per group | `variants: string[]`, `count` | url_normalised |
| `url.tracking-params-internal` | CHECK-28 | url | warning | internal `links` rows whose target_url carries a tracking param — one finding per TARGET (cap 200) | `targetUrl`, `params: string[]`, `inlinkCount` | target url |
| `url.parameter-pages-indexable` | CHECK-27 | url | info | indexable 200 pages with a query string AND a self-referential effective canonical (parameter variants canonicalised to themselves — the risky configuration; the url_params inventory is the agent's context) — cap 200 | `url`, `params` | page url |
| `host.http-serves-200` | CHECK-14 | host | warning | host_probe_jsonb: an `http://` variant whose final hop is 200 (not a redirect into https) — site-scoped per variant | `variant`, `hops` | variant |
| `host.duplicate-host-200` | CHECK-15 | host | warning | both www and apex https variants terminate in 200 (no canonical host redirect) | `variants`, `finals` | "www-apex" |
| `host.legacy-host-reachable` | CHECK-15 | host | info | a configured legacy host variant terminates in 200 | `variant`, `hops` | variant |

Host rules are data-gated on `host_probe_jsonb` being present (probe skipped → one site-scoped info finding `evidence.skipped` per the orphan-gate pattern — a disabled probe is visible).

- [ ] **Step 1: Failing tests** (derivation: pages with `?utm_source=x&b=1` → two url_params rows, is_tracking split, idempotent re-run; each rule per pattern; host rules against hand-built host_probe_jsonb).
- [ ] **Step 2: Implement + copy; green. Step 3: Full suite; commit** — `feat: url/host hygiene rules + url_params derivation (P3-T4, P3-T8, CHECK-14/15/27/28/30)`

---

### Task 7: Soft-404 + near-duplicates (CHECK-13, 39)

**Files:**
- Create: `src/rules/query/content.ts`
- Modify: copy, index
- Test: `test/rules/content-query.test.ts`

| id | checkIds | category | severity | fires when | evidence | dedupeKey |
|---|---|---|---|---|---|---|
| `content.soft-404` | CHECK-13 | content | warning | indexable `ok` 200 page AND ( `has_soft404_phrases` AND `word_count < 300` ) OR ( notfound-probe returned 200 AND `bit_count((pages.simhash # $probeSimhash)::bit(64)) <= 4` ) — the two signal paths named in evidence | `signals: ("phrases"|"template-match")[]`, `wordCount`, `hammingToTemplate` (when probe exists) | page url |
| `content.exact-duplicate` | CHECK-39 | content | warning | `GROUP BY content_hash HAVING count(*) > 1` over indexable 200 pages — one finding per group, pageUrl = first member | `urls: string[]` (cap 20), `count`, `pageTypes: string[]` | content_hash |
| `content.near-duplicate` | CHECK-39 | content | warning | simhash pair with hamming ≤ 3, excluding exact-duplicate pairs — banded candidate join + `bit_count` verification, all in SQL; one finding per PAIR, capped at 500 pairs (truncation counted in one site-scoped info evidence row) | `urlA`, `urlB`, `hamming`, `pageTypeA`, `pageTypeB` | `sorted(urlA,urlB)` hash |

**The banding SQL** (Postgres bigint ops work on the signed value directly — band equality and XOR are representation-level, sign-safe):

```sql
SELECT a.url AS url_a, b.url AS url_b,
       bit_count((a.simhash # b.simhash)::bit(64)) AS hamming,
       a.page_type AS type_a, b.page_type AS type_b
FROM pages a
JOIN pages b ON b.crawl_id = a.crawl_id AND a.id < b.id
  AND a.content_hash IS DISTINCT FROM b.content_hash
  AND ( (a.simhash >> 0)  & 65535 = (b.simhash >> 0)  & 65535
     OR (a.simhash >> 16) & 65535 = (b.simhash >> 16) & 65535
     OR (a.simhash >> 32) & 65535 = (b.simhash >> 32) & 65535
     OR (a.simhash >> 48) & 65535 = (b.simhash >> 48) & 65535 )
WHERE a.crawl_id = $1 AND a.fetch_class = 'ok' AND a.is_indexable = true
  AND b.fetch_class = 'ok' AND b.is_indexable = true
  AND a.simhash IS NOT NULL AND b.simhash IS NOT NULL
  AND bit_count((a.simhash # b.simhash)::bit(64)) <= 3
LIMIT 501;
```

(4 bands × 16 bits guarantees any pair with hamming ≤ 3 shares at least one band — pigeonhole; the arithmetic-shift sign bits cancel in band comparison because both sides shift identically. State this reasoning in the rule comment.)

- [ ] **Step 1: Failing DB tests** — soft-404 via phrases (insert a page with the flag + 80 words), via template (crawls row with a notfound_probe simhash 2 bits from a page's), and the negative (phrases but 500 words + no template → silent); near-dup pair built from two simhashes hand-crafted 2 bits apart (compute in the test with `simhash64` on two near-identical strings — also pins the analyzer↔SQL signed-bigint round-trip end to end); exact-dup pair via equal content_hash (and excluded from near-dup).
- [ ] **Step 2: Implement + copy; green. Step 3: Full suite; commit** — `feat: soft-404 + duplicate content rules (P3-T5, P3-T6, CHECK-13/39)`

---

### Task 8: Structured-data rules + field-presence derivation (CHECK-43, 44, 45, 46)

**Files:**
- Create: `src/rules/query/structured-data.ts`, `src/rules/derive/field-presence.ts`
- Modify: `src/rules/run.ts` (register the derivation), copy, index
- Test: `test/rules/structured-data-query.test.ts`, `test/rules/derive-field-presence.test.ts`

**Derivation:** `deriveFieldPresence(db, crawlId)` — for `structured_data` rows of profiled types, compute `field_presence_jsonb` from `raw_jsonb`: `{ required: {name: true, image: false, …}, recommended: {…} }`. Profiles (module const `SCHEMA_PROFILES`): `Product` required `[name, image, offers]` + offers requires one of `price`/`priceSpecification`, recommended `[description, sku, brand, aggregateRating, review]`; `BreadcrumbList` required `[itemListElement]`. Idempotent update-in-place.

| id | checkIds | category | severity | fires when | evidence | dedupeKey |
|---|---|---|---|---|---|---|
| `schema.none-on-site` | CHECK-43 | structured-data | info | zero structured_data rows for the crawl — site-scoped | `indexablePages` | "site" |
| `schema.product-incomplete` | CHECK-44 | structured-data | warning | a Product row whose field_presence has any required field false — per page | `missingRequired: string[]`, `missingRecommended: string[]` | page url |
| `schema.breadcrumb-absent` | CHECK-45 | structured-data | info | site has ZERO BreadcrumbList rows while having ≥ 5 indexable 200 pages — site-scoped (per-page breadcrumb coverage is Phase 4's metric) | `indexablePages` | "site" |
| `schema.self-serving-reviews` | CHECK-46 | structured-data | info | a row of type `Organization` or `LocalBusiness` whose raw contains `aggregateRating` or `review` (Google policy: self-serving) — per page | `schemaType`, `fields` | `${pageUrl}#${type}` |

- [ ] **Step 1: Failing DB tests** (derivation: a Product raw missing image → presence false + rule fires with `missingRequired: ["image"]`; a complete Product → silent; breadcrumb-absent fires only past the 5-page floor; Organization+aggregateRating fires; Product+aggregateRating does NOT fire self-serving).
- [ ] **Step 2: Implement + copy; green. Step 3: Full suite; commit** — `feat: structured-data rules + field-presence derivation (P3-T7, CHECK-43..46)`

---

### Task 9: Fixture harness — sitemap, multi-page clusters, every new rule claimed

**Files:**
- Modify: `test/fixtures/app.ts` (sitemap.xml route), `test/fixtures/fixture.ts` (if the contract needs a `sitemap?: boolean` flag), `test/fixtures/pages/absorbed.ts` (fill the empty `expectedIssues` on redirect/duplicate/orphan pages now that their rules exist), `test/fixtures/harness.test.ts`
- Create: `test/fixtures/pages/authored-p3.ts`
- Test: the harness itself

**The fixture work:**
- The app gains `/sitemap.xml` (referenced from robots.txt) listing: most fixture paths, PLUS an orphan-only page (`/authored3/orphan` — in the sitemap, linked from nowhere), a 404 entry, an entry that redirects, and a noindex entry — feeding `sitemap.non-200/redirected/non-indexable` and `links.orphan`. A page NOT in the sitemap feeds `pages.not-in-sitemap`.
- Multi-page clusters in `authored-p3.ts` (each cluster's pages `exact: true` with honestly-enumerated sets): redirect chain `/authored3/chain-a→b→c→200` and headless loop pair (registered as handler-level redirects); hreflang return-link broken pair + happy pair; pagination trio (`/authored3/paged-1,2,3` with rel prev/next; page 2 canonicalised to page 1 → `pagination.canonical-to-other`); soft-404 page (200, "this page cannot be found", 60 words); near-dup pair (two ~200-word pages differing by a few words — verify hamming ≤3 by running `simhash64` in the fixture test before relying on it); exact-dup pair (byte-identical bodies); tracking-link page (internal `<a href="/control?utm_source=news">`); case-variant pair (`/authored3/Case` and `/authored3/case` both served); Product-schema page missing `image`; Organization+aggregateRating page. Host rules fire from the real probe against the fixture server (`www.localhost` variant per the established technique — assert at least `host.duplicate-host-200` or record the environment-dependent caveat the way loop tests did).
- Absorbed pages with `expectedIssues: []` and a "Phase 3" comment now get their real expectations (redirect chain/loop pages, duplicate pair, broken-link/404 page, orphan/dead-end page) — delete the stale comments.
- Harness: `runRules` already runs derivations + query rules; the every-rule-fires assertion now covers ~50 rules; the site-scoped set assertion is updated for the new site-scoped findings the fixture site legitimately produces (enumerate them exactly). The `sitemap.missing`/`robots.missing` rules must NOT fire (the app now has both) — the control expectation extends to site-level: assert the exact site-scoped finding set.

- [ ] **Step 1: Wire fixtures, run the harness, iterate until every new rule fires and the exact-set assertions enumerate honestly** (RED naturally: the strict every-rule-fires assertion fails until the last fixture lands).
- [ ] **Step 2: Full suite + typecheck; commit** — `feat: phase 3 fixtures — sitemap, clusters, every query rule claimed`

---

### Task 10: Coverage pin → the seven, gate record

**Files:**
- Modify: `test/rules/coverage.test.ts`
- Create: `docs/gates/phase-3.md`

- [ ] **Step 1: Update the pin.** Unclaimed literal becomes exactly `["CHECK-01","CHECK-02","CHECK-08","CHECK-29","CHECK-33","CHECK-33b","CHECK-34"]`; add the assertion that this equals `[...RENDER_CHECKS, ...METRIC_PENDING_CHECKS].sort()` (the annotation and the pin can never drift); update the claimed-side literal (15 → 37) and the arithmetic (37 + 3 + 7 = 47). VERIFY against the real registry before committing, as in Phase 2 — every delta hand-checked.
- [ ] **Step 2: Gate doc** (`docs/gates/phase-3.md`): date, commit, rule count by kind, the claimed/agent/pinned split with the amendment's rationale (render → P5, metrics → P4), fixture count, harness assertion results, CI run link once the PR exists ("pending the first pull request" wording — the trigger is PR/main-push).
- [ ] **Step 3: Full suite + typecheck green; commit** — `test: phase 3 gate — 37 claimed, pin shrunk to render+metric seven, recorded`

---

## Self-Review (performed at authoring time)

- **Spec coverage:** P3-T1→Task 3 (redirect SQL incl. headless-cycle pass), P3-T2→Tasks 3+4 (broken links, orphans-gated, canonical targets, hreflang return/target), P3-T3→Task 5, P3-T4→Task 6, P3-T5→Task 7 (soft-404 full mechanism per amendment), P3-T6→Task 7 (banding + `bit_count`; similarity buckets/pair matrix are Phase 4 metrics), P3-T7→Task 8, P3-T8→Tasks 2+6 (probe + rules). Gate→Task 10 under the owner-approved amendment. Housekeeping seeds→Task 1; crawl prerequisites→Task 2; fixtures→Task 9.
- **Check arithmetic:** claims added: 03, 06, 07, 09, 10, 11, 14, 15, 19, 22, 23, 24, 26, 27, 28, 30, 32, 39, 43, 44, 45, 46 = 22 (13 re-claimed by soft-404, 25 re-claimed by the x-default upgrade — both already counted in Phase 2's 15). 15 + 22 = 37 claimed; +3 agent +7 pinned = 47. ✓
- **Type consistency:** `queryFinding`, `RuleCategory`, `RENDER_CHECKS`/`METRIC_PENDING_CHECKS`, `resolveEffectiveCanonical` export, `deriveUrlParams`/`deriveFieldPresence`, `probeHostVariants`/`HostProbeResult`, the three `crawls` jsonb columns and `pages.has_soft404_phrases` are each defined once in their producing task and consumed by name later.
- **Deliberate at-execution blanks:** fixture `expectedIssues` enumerations (verified by running, per the Phase 2 precedent), the harness's exact site-scoped finding set, and the copy text for ~22 new ids (the writing IS the task; accuracy constraints: soft-404 copy names both signal paths; near-dup copy says hamming-based similarity, not plagiarism detection; host copy describes the probe, not a crawl of the variant).
- **Known risks named:** recursive CTE cost on pathological redirect farms is depth-capped at 10 and head-scoped; the banding join is quadratic within a band — acceptable at ≤16-bit band cardinality for ≤50k pages, revisit at the Phase 4 gate if slow; `www.localhost` resolution is environment-dependent (systemd-resolved) — the host-rule fixture assertion must not hard-depend on it (follow the loop-test precedent).

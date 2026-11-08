# Phase 27 — Agent control plane

Date: 2026-11-08. Roadmap: `docs/superpowers/specs/2026-11-04-roadmap-design.md`.
Predecessor gate: Phase 26c (`docs/gates/phase-26c.md`, merged in PR #24, `bc9ce32`).

Status: design, awaiting owner review. Owner direction (2026-11-08): skip the question
round and write it from the roadmap. Two answers taken after a builder review are marked
"owner, 2026-11-08".

## Intent

Ariadne is operated by agents. Today an agent can start a crawl, wait for it, and read
it, but it cannot steer one:

- It cannot stop or pause a crawl.
- It cannot read back what it asked for.
- It cannot point a crawl at a list of URLs, fence a crawl off from part of a site, or
  crawl a staging site behind a password.
- It cannot tell the engine "on this site, that rule doesn't matter".

Phase 27 closes those gaps. It also adds the two summary reports a practitioner opens
first: the Issues Overview and the Crawl Overview.

Two constraints shape everything below.

- **The schema is the allowlist** (roadmap). Anything an agent can set is in one
  published schema, and anything not in it is refused. No hidden knobs, and no field
  accepted on one transport but not the other.
- **The engine still measures. The agent judges.** (`docs/talos-integration.md`
  obligation 6.) The new issue type and priority are, like severity, *defaults that
  belong to a rule*, written down once in a table and blind to this site. The agent
  overrides them per crawl, and every override is visible on every surface that it
  changes.

### The priority axis was rejected once

Phase 16 (`docs/superpowers/specs/2026-09-08-severity-recalibration-design.md`) rejected
a Screaming-Frog-style second `priority` axis because it "puts a second judgement call
in the engine". The roadmap (owner-agreed 2026-11-04, newer) brings it back: "Absorbs
the old Phase 25's priority axis." This design follows the roadmap. What makes it
compatible with Phase 16's reasoning is the override layer that did not exist then.
The engine ships a default type and priority per rule, the same way it ships a default
severity, and the agent, which knows the site, can change both per crawl. Severity
keeps its Phase 16 meaning and rubric and is not overridable (see 27a). That clause of
`docs/talos-surface.md` §10, "No prioritisation beyond rule severity", is rewritten in
27a.

## Shape: three sub-phases, each with its own plan and gate

| Sub-phase | What | Crawl-loop changes | Ruleset |
|---|---|---|---|
| **27a** | Judgement: type × priority, per-crawl overrides and thresholds, Issues Overview and Crawl Overview | none | 0.23.0 |
| **27b** | Lifecycle and the config schema: pause, cancel, delete; schema get / set / validate | batch-boundary control polling, abort reaches in-flight fetches | — |
| **27c** | Crawl scope and requests: list mode, URL excludes and includes, custom headers, HTTP auth, cookies, new limits | frontier admission, request building | 0.24.0 |

Cheapest and safest first:

- **27a** never touches a crawl. It works on every stored crawl with a rules re-run.
- **27b** touches the crawl loop's control flow but not what gets fetched.
- **27c** changes what gets fetched and how, so it carries the new fetch class and the
  politeness checks.

27b comes before 27c because 27c's fields are set through 27b's schema, and some of
them can only change while a crawl is paused.

---

## 27a — Judgement and overviews

### Issue type and priority

Every page and query rule gains two registry fields beside `severity`:

- `type`: `issue | warning | opportunity`.
  - **Issue**: the finding is a defect to fix.
  - **Warning**: a human needs to check it, because it may be fine.
  - **Opportunity**: nothing is broken, but changing it would help.

  These match Screaming Frog's Issue Type vocabulary, which practitioners already read.
- `priority`: `high | medium | low`. This is the expected effect of fixing it on the
  pages it hits:
  - **high**: affects whether those pages are crawled, indexed or served correctly;
  - **medium**: affects how they rank or appear in results;
  - **low**: hygiene.

  The rubric goes into the copy module's header, like the severity rubric.

Metric rules have neither field, because they produce no findings. Marker rules (the
"not measured" rules) are `warning` and `low`: a check that could not run is something
to look at, not a defect on the site.

**Where the values live:** one table, `src/rules/registry/triage.ts`, mapping each rule
id to `{type, priority}`. A finding rule missing from the table fails registry load, the
same way missing copy does today. A test pins the table's coverage to the registry. New
rules in later phases add their row as part of the rule.

**How they are assigned:**
- **Reference.** Every rule that maps to a Screaming Frog issue takes SF's Issue Type
  and Issue Priority as its reference. These come from a black-box SF run on the
  fixture site, like the 26a calibration, with SF's research files kept local.
- **Everything else** is assigned from the rubric above.
- **Gate output.** The gate doc lists every rule where we differ from SF, with the
  reason.

**Not stored per finding.** Type and priority are joined from the registry, plus the
crawl's overrides, at read time. That is what lets an override take effect without
re-running the rules. Severity stays stored per finding as today.

### Per-crawl overrides (the `judgement` block)

A crawl's config gains a `judgement` block, stored in `crawls.judgement_jsonb` (a new
nullable column, migration 0031).

```
judgement: {
  rules?: { [ruleId]: { disabled?: true, type?: Type, priority?: Priority } },
  thresholds?: { [name]: number },
  findingCap?: number | null          // moved here from the top level; old key still accepted
}
```

**Disabled, retyped and reprioritised rules apply at read time.**
- **Changing them:** they can be changed at any time except while rules are running for
  that crawl. That case is refused, not queued.
- **A disabled rule:**
  - its findings disappear from `issues_list`, the Issues Overview, the CSV views and the
    `issue_urls` / `issue_inlinks` listings;
  - it is still listed in `rules_catalog`, with `disabled: true`;
  - every listing response names the disabled rules in a `disabledRules` field, so a
    reader can always tell "filtered out" from "did not fire".
- **Stored findings are kept**, so re-enabling a rule brings its findings back
  immediately.
- **Unknown rule ids are refused.** Metric rules cannot be disabled or retyped.
- **Severity cannot be overridden.** It is the engine's fact about the rule (Phase 16).
  An agent that disagrees changes priority or disables the rule.

**Thresholds apply at the next rules run.** Rules read thresholds through an accessor
instead of the static import. The Phase 26a thresholds module was built for exactly this
swap.
- **The run stamps them.** Each rules run stamps the effective thresholds it used on the
  crawl, in `crawls.rules_thresholds_jsonb` (migration 0031).
- **Copy follows the stamp.** Issue copy that names a number is rendered from the stamped
  values, so the explanation and the evidence never disagree. Today
  `test/rules/copy.test.ts` pins the prose to the constants; it will pin it to the
  rendered values instead.
- **Only some thresholds are overridable.** The overridable set is the allowlist below.
  Each has bounds in the schema, and cross-field pairs are checked (min < max).
  - Allowed: `TITLE_MIN/MAX`, `META_MIN/MAX`, `H1_MAX`, `H2_MAX`, `URL_MAX`,
    `TITLE_PX_MIN/MAX`, `META_PX_MIN/MAX`, `SLOW_MS`, `DEEP_DEPTH`, `THIN_WORDS`,
    `SOFT_404_WORDS`, `IMAGE_WEIGHT_WARN`, `CHAIN_HOPS`,
    `HIGH_INTERNAL_OUTLINKS`, `HIGH_EXTERNAL_OUTLINKS`, `UNAVAILABLE_AFTER_WARN_DAYS`.
  - Not overridable:
    - extraction-time limits (`IMAGE_ALT_MAX` is applied by the extractor at crawl
      time, and only a count is stored; changing it would need a re-crawl);
    - similarity distances (`TEMPLATE_HAMMING`, `NEAR_DUPLICATE_*`);
    - render heuristics (`CSR_*`, `NAV_*`, `FILTER_*`);
    - walk bounds (`CANONICAL_MAX_HOPS`, `PAGINATION_WALK_MAX`);
    - protocol limits (`SITEMAP_*`);
    - the word and parameter lists.

    These are engine internals or protocol facts, not site preferences.

**A rules run executes every rule, disabled ones included,** and stores all their
findings. That is what lets a re-enable show findings immediately, even after a later
re-run. `site.health` is the one stored aggregate. It is computed from the findings of the
rules that were enabled at that moment.

**Staleness is reported, never hidden.** When the crawl's current judgement
block differs from the one that run used, the change is visible:
- `crawl_status` reports `judgementStale: true`, with the reason (`overrides` or
  `thresholds`);
- every response that carries `site.health` or threshold-dependent findings carries the
  same flag.

Re-running the rules clears it. The run stamps a hash of the inputs it used, which is how
the two are compared. Those inputs are the disabled set, the thresholds and `findingCap`
(reason `findingCap`). Retyping and reprioritising are not part of the hash, because they
change nothing stored.

`findingCap` keeps its existing meaning. At `crawl_start`, the old top-level key is still
accepted and is stored as `judgement.findingCap`. If both are given, they must agree or
the request is refused.

### Issues Overview

This is one row per finding rule. It is Screaming Frog's Issues tab, with our axes.

- **Surfaces:**
  - `issues_overview` (MCP);
  - `GET /crawls/:id/overview/issues`;
  - the CSV view `issues_overview`.
- **Row:**
  - `ruleId`, `title`;
  - `type`, `priority` (each with an `overridden` flag), `severity`;
  - `category`, `checkIds`;
  - `urls` (distinct pages with a finding; site-level findings count 1);
  - `percentOfJudged` (against `site.health`'s Pages Judged).

  CSV only: `explanation`, `howToFix`.
- **Rows included:** by default, only rules that fired. `includeZero` adds rules that
  ran with no findings, at `0`. Markers are included, because "not measured" must stay
  visible.
- **Order:** type (issue, warning, opportunity), then priority, then `urls` descending,
  then `ruleId`.
- **Size:** bounded by the rule count (188 today), so it is not paginated. This meets
  the "never a full export inline" obligation because it is an aggregate.

### Crawl Overview

Counts that describe the crawl, not the site's quality: Screaming Frog's crawl overview
panel, built from what we store.

- **Surfaces:**
  - `crawl_overview` (MCP);
  - `GET /crawls/:id/overview/crawl`;
  - the CSV view `crawl_overview`, with columns `section, label, value, percent`.
- **Sections**, each one a bounded `GROUP BY`:
  - **URLs:** encountered, fetched, unfetched in the frontier, robots-blocked (stored and
    dropped), and excluded (27c), each from a stored column.
  - **Fetch class:** count per `fetch_class`, with null shown as its own "not asked" row.
  - **Status class:** 2xx / 3xx / 4xx / 5xx / no response.
  - **Content:** HTML pages by page type; non-HTML pages by content-type family; resources
    by kind (image / CSS / JS).
  - **Indexability:** indexable, and non-indexable by reason. The reasons are the
    existing `indexability_status` values.
  - **Depth:** click depth 0–9 and 10+, plus unreachable. These are read from the existing
    depth metrics where they exist, never recomputed differently.
  - **Discovery:** count per `discovered_via`, and in-sitemap versus not-in-sitemap.
  - **Response time buckets:** under 250 ms, 250–500, 500–1000, 1000–`SLOW_MS`, and over
    `SLOW_MS`.
  - **Render:** pages rendered and the render coverage state.
  - **Issues grid:** finding counts by type × priority, after overrides.
- **Null versus zero:** the existing rule (`talos-surface.md` §5) holds. A section the
  crawl could not measure is absent and named, never zero. Examples are depth on a list
  crawl (27c) and render on a crawl that never rendered.

### Gate 27a

- Full suite and the harness green, with 0 skipped; `tsc` clean.
- The triage table covers every finding rule. The SF comparison table is in the gate
  doc.
- **Re-judge the stored lavishalice crawl** (no re-crawl):
  - Issues Overview counts equal `issues_list` counts rule by rule.
  - Crawl Overview totals reconcile with `crawl_status` (`pagesCrawled`, frontier,
    blocked).
- **One override round-trip:**
  - disable a rule, retype one and reprioritise one: each shows up immediately on every
    surface;
  - set one threshold: findings are unchanged until the rules re-run, `judgementStale` is
    true in between, and afterwards the findings, the copy and the stamp agree.

---

## 27b — Lifecycle and the config schema

### Pause, cancel, delete

New commands, each one a tool and a route:
- `crawl_pause` / `POST /crawls/:id/pause`
- `crawl_cancel` / `POST /crawls/:id/cancel`
- `crawl_delete` / `DELETE /crawls/:id`

Resume is the existing `crawl_resume`.

**Control goes through the database, not process memory.** A new nullable
`crawls.control_request` column (`pause | cancel`, migration 0032) is set by the command
and polled by the crawl loop:
- at every batch boundary;
- in the admit and claim waits, which already watch the abort signal;
- between sitemap documents during discovery.

Phase 28 runs crawls on several workers, and an in-memory abort would only reach the
process that happens to hold the crawl. This works there unchanged.

- **On a queued crawl:**
  - **pause:** the crawl is taken out of the wait queue and becomes `paused`.
  - **cancel:** the crawl becomes `cancelled`.
  - Both happen immediately, and the response says so.
- **On a running crawl:**
  - The command returns 202 with `controlRequested`.
  - At the next poll the loop stops admitting work, and in-flight fetches are aborted.
    `fetchPage` takes the crawl's signal; today it has only its own 20 s deadline. An
    aborted fetch puts its URL back in the frontier, so it does not become a failed row.
  - Leases are released and the status is set.
  - The status change happens within one poll interval plus the abort settle time. The
    gate measures that.
- **Pause** keeps the frontier, the per-host spacing and the throttle record, and a
  resume starts from them. A paused crawl stays paused across a process restart; it is
  never adopted.
- **A shutdown is a pause.** Today a graceful-shutdown abort writes `cancelled` with the
  frontier intact, and `crawl_resume` resumes it (`loop.ts:408`, `service.ts:3029`). From
  27b a shutdown writes `paused` with `pauseReason: "shutdown"`, against
  `pauseReason: "request"` for an agent's pause, so `cancelled` means only what an agent
  asked for.
  - **Stored crawls:** migration 0032 relabels the existing `cancelled` crawls as `paused`
    with reason `shutdown`. Every one of them was written by a shutdown, because no other
    path writes `cancelled` today.
- **Cancel** is final: `crawl_resume` refuses a cancelled crawl.
  - After the loop stops, the crawl closes the same way an interrupted crawl does today:
    template inference and `closeCrawl` run. The 404 probe, the resource pass and the 5xx
    recheck pass are skipped.
  - Their checks stay "not measured" through the existing markers
    (`resources.not-fetched` and the recheck's null states), never a pass. Cancel means
    "stop now".
  - What was crawled stays judgeable. `crawl_rules` runs on a cancelled crawl, as it does
    on a finished one.
  - `crawl_status` records `cancelledAt` and how many URLs were never fetched.
- **The render pass and rules runs** happen inside a request, not in the crawl loop.
  Both already refuse `queued` and `running` crawls, so they can collide only with a
  paused crawl.
  - **Rendering and judging a paused crawl stays allowed.** Looking at partial results is
    a reason to pause.
  - **While either runs**, the following are refused (409), and the refusal names the
    operation: `crawl_resume`, `crawl_cancel`, `crawl_delete`, and `crawl_config_set` on
    `crawl` fields.
  - **Neither can be interrupted** in this phase.
  - **The guard stays in-process for now.** The rules-run guard is the in-process
    `judging` set, and the render pass gets the same kind of guard. Phase 28 moves both
    to the database along with the worker claim. They are recorded there as carried
    work.
- **Delete** removes a crawl, every row that belongs to it, and its files. Every foreign key to
  `crawls` already cascades; the plan re-checks that per table.
  - It is refused for `queued`, `running` and any crawl with live leases or a pending
    control request.
  - It needs `confirm` set to the crawl id. That is a guard against an agent deleting the
    wrong crawl from a list, and it is not authorisation. The bearer token is the
    authorisation.
  - It also removes the crawl's files on disk: its render artifacts under `renderDir`
    and its exports under `exportDir`.
  - It returns the per-table row counts and the file count deleted. Nothing is
    soft-deleted.
  - A crawl that another crawl's comparison referenced is still deletable, because
    comparisons are computed, not stored.
  - **Tenancy:** until Phase 28's tenant key, anyone with the token who knows a crawl id
    can delete it. The same is already true of every per-crawl command. The note in
    `talos-surface.md` §9 is extended to say so.

`status` gains `paused`. The column stays free text, so no enum migration is needed.
`crawl_resume` already gates on owed work, not on status; it now also refuses
`cancelled`.
`crawl_list` and `crawl_status` show it, and `queuePosition` is null for a paused crawl.

### Config as a schema: get, set, validate

**One source.**
- **The schema:** a zod 4 schema (`src/api/config-schema.ts`) becomes the single
  definition of what a crawl accepts. It has two parts:
  - `crawl`: what to fetch and how;
  - `judgement`: the 27a block.
- **The JSON Schema is generated from it.** zod 4's built-in `z.toJSONSchema` produces
  draft 2020-12, the version that is published.
- **One parser for both transports.** The hand-rolled `parseStartCrawlInput` field table
  and the separate MCP shape in `mcp.ts` are replaced by the one schema, so HTTP and MCP
  accept exactly the same fields.
- **Contract kept.** Existing refusals keep their codes (`VALIDATION_ERROR`, with the
  offending path) and their meaning. For example, a `perHostDelayMs` under 250 is
  refused, not clamped. The tests that pin today's messages move to the schema.

**Field metadata in the schema.**
- **`x-ariadne-mutable`:** each field says whether it can change after the crawl starts:
  `never` or `whenPaused`. The `judgement` fields are `always`, with the 27a exception
  while rules run.
- **`x-ariadne-secret`:** marks the fields whose values are never stored or returned
  (27c).
- **Defaults** are in the schema, so `config_validate`'s effective config is
  self-explaining.

**Tools and routes:**
- **`config_schema`** (`GET /config/schema`) returns the JSON Schema and the
  `rulesetVersion`. The overridable thresholds appear with their defaults and bounds.
- **`config_validate`** (`POST /config/validate`) is a dry run. It returns
  `{valid, errors: [{path, code, message}], effective}`, where `effective` is the config
  after defaults and operator defaults (`ServiceConfig.crawlDefaults`) are applied.
  It checks the allowlist (`ARIADNE_ALLOWED_DOMAINS`) and runs url-policy on `siteUrl`
  and every listed URL, but performs no DNS lookup. DNS is checked at start, as today.
- **`crawl_config_get`** (`GET /crawls/:id/config`) returns the stored effective config,
  with secrets as `"[redacted]"` and each field's mutability.
  - Today `crawl_status` echoes four fields. This returns all of them.
- **`crawl_config_set`** (`PATCH /crawls/:id/config`) applies a partial update,
  validated against the schema.
  - `judgement` fields apply as in 27a.
  - `crawl` fields can change only when the crawl is `queued` or `paused`, and only if
    marked `whenPaused`. Anything else is refused with the field's path and its
    mutability.
  - `whenPaused` covers `maxPages` (not below the pages already fetched), `maxDepth`,
    `perHostDelayMs`, `maxConcurrency`, the render budgets, the 27c excludes and includes,
    and supplied credentials.
  - `never` covers `siteUrl`, `mode`, `urls`, `userAgent`, `sitemapUrls` and `legacyHosts`.
    The evidence of a crawl must come from one identity and one scope.

### Gate 27b

- Full suite green, with 0 skipped.
- **On the fixture site:**
  - a crawl paused mid-way and resumed ends with the same set of page URLs and
    fetch classes as an uninterrupted crawl;
  - a cancel reaches `cancelled` within the measured bound, and no URL is left as a
    failed row because of the abort;
  - a delete leaves zero rows for that crawl in every table, checked by a query over
    every table with a `crawl_id`, and no files under `renderDir` or `exportDir`;
  - a paused crawl survives a service restart still paused.
- **Contract checks:**
  - every transport accepts and refuses the same fields: a test walks the JSON Schema and
    drives both transports;
  - `config_validate` and `crawl_start` agree on every refusal case.
- **The 50k memory gate is re-run** with one pause and one resume part-way. The peak
  must be at or below 512 MB and within 5% of 26c's 293.7 MB.

---

## 27c — Crawl scope and requests

### List mode

`crawl.mode`: `spider` (default; today's behaviour) or `list`.

- **Input:**
  - `urls` holds up to 10,000 URLs, with a request body of up to 1 MiB. The body cap is
    raised for `POST /crawls` and `POST /config/validate` only; the other routes keep
    64 KiB.
  - Each URL is normalised, passes url-policy and the domain allowlist, and must be in
    `siteUrl`'s site family (apex or `www`, `http` or `https`), the same boundary a
    spider crawl has.
  - Lists that span several sites are refused, not split.
  - `siteUrl` is still required; robots and the allowlist key off it.
- **What a list crawl fetches:**
  - Every listed URL, at depth 0.
  - Redirects are followed to their target, within `maxRedirectHops`, so every listed URL
    ends in a classified row.
  - Links are recorded but not followed. Sitemaps are not read unless `sitemapUrls` is
    given.
  - robots.txt is always read and obeyed.
  - The resource pass and the render pass work as in spider mode.
- **Rules:**
  - Rules that need the whole site cannot be measured on a list crawl. These cover the
    complete link graph, click depth, sitemap coverage, orphans, and inlink-dependent
    checks such as "only linked from non-indexable" and unlinked canonical or hreflang
    targets.
  - Each such rule declares it in the registry (`needsSpider: true`). On a list crawl
    they do not run. One new marker, `crawl.list-mode` (info), names every one of them.
  - Rules about the listed pages themselves run normally, including duplicates within
    the list.
  - This is hard rule 1: absence on a list crawl reads "not measured", never "clean".
  - The plan lists which rules get the flag. That is ruleset 0.24.0.

### Excludes and includes

Owner (2026-11-08): the roadmap's "URL and link-path excludes" means URL patterns. There
are no link-position excludes (nav, footer).

- **Fields:**
  - `crawl.exclude` and `crawl.include` are each up to 100 patterns of up to 512
    characters.
  - A pattern is matched against the whole normalised URL. `*` matches any run of
    characters, and the pattern is anchored at both ends, so `*/blog/*` is a path rule
    and `https://shop.example.com/*` a host rule.
  - There are no regular expressions. A linear-time wildcard matcher means an
    agent-supplied pattern cannot hang the frontier, and there is no ReDoS surface.
- **Evaluation, at admission** for every link, sitemap and redirect target, after
  url-policy and before robots:
  - an `exclude` match is refused;
  - with a non-empty `include` list, a URL matching none is refused;
  - exclude wins;
  - the seed and listed URLs are checked too. A seed that is excluded fails `crawl_start`
    with a validation error, not an empty crawl.
- **Refused URLs are recorded, not dropped.** They become `pages` rows with the new fetch
  class `excluded`, written the way robots-blocked URLs are written today as `disallowed`
  rows, and never fetched. `fetch_reason` names the matching pattern. They share the
  `maxBlockedUrls` budget with robots-blocked rows; beyond it they are counted in
  `excluded_dropped`, mirroring `robots_blocked_dropped`.
  - Every rule that reads fetch classes treats `excluded` like `disallowed`: not judged,
    and not a broken link. The plan audits each rule's `fetch_class` handling.
- **Changed while paused,** the lists are applied again when the crawl resumes.
  - Unfetched frontier rows that the new lists refuse are moved to `excluded` rows by one
    batched SQL pass before the loop starts. That keeps it memory-safe: patterns translate
    to escaped `LIKE` with identical semantics, and a test pins the JS matcher and the SQL
    form to each other.
  - Pages already fetched stay as they are.
  - `crawl_config_get` shows when the lists last changed.
- **A pattern that can never match is refused** at validation. That means one whose scheme
  and host part names a host outside the crawl's site family, so a typo in the host does
  not silently fence off nothing.

### Custom headers, HTTP auth, cookies

- **Fields:**
  - **`crawl.requestHeaders`:** up to 20 `{name: value}` pairs. A name must be an HTTP
    token, and a value is at most 1 KiB with no CR or LF. Some names are refused because
    the engine owns them or they have their own field: `host`, `user-agent`, `accept`,
    `accept-encoding`, `content-length`, `connection`, `transfer-encoding`, `te`,
    `upgrade`, `cookie`, `authorization`, and `proxy-*`.
  - **`crawl.httpAuth`:** `{username, password}`, Basic only.
  - **`crawl.cookies`:** up to 50 `{name, value}` pairs, sent as one `Cookie` header.
    `Set-Cookie` from the site is ignored: the crawl stays stateless, so page N never
    depends on page N−1.
- **Where they are sent:** only to requests whose host is in the crawl's site family,
  including robots.txt, sitemaps and same-family resources.
  - They are never sent to other hosts, which covers resources on a CDN, cross-host
    redirects, and the render pass's third-party requests. A redirect that leaves the
    family drops them for that hop.
  - The render pass applies the same rule per request through its existing route
    handler.
- **Secrets are never stored.** The values of all three fields (`x-ariadne-secret`) are
  held only in the process's memory for the crawl. They are not written to
  `config_jsonb`, logs, errors or any response. The existing `request_headers` evidence
  redaction already covers `authorization` and `cookie`, and it gains the custom header
  names.
  - **The test:** after a crawl with each kind of credential, it scans every text and
    jsonb column of every crawl-scoped table for the secret values, and finds none.
  - **What is stored:** which fields were supplied, and the header and cookie names, so
    `crawl_config_get` can say `httpAuth: "[redacted]"`.
  - **After a restart:** if the process restarts, a crawl that needs credentials no
    longer has them. `crawl_resume` and `crawl_render` refuse with
    `CREDENTIALS_REQUIRED` until they are re-supplied. Both accept the secret fields,
    and `crawl_config_set` does too when the crawl is paused. A crawl never continues
    unauthenticated against a site that needed auth, which would quietly turn every page
    into a 401 row.
- **Politeness and identity are not negotiable.** These fields cannot change the user
  agent, the delay floor or robots. A site that needs a different UA uses the existing
  `userAgent` field.

### Limits

- **New fields:**
  - **`crawl.maxRedirectHops`** (default 10, range 1–20) caps one redirect chain in the
    page crawl, which today has no cap. A chain over the limit ends in a classified row
    with `fetch_reason` naming the cap. The frontier row carries a hop count (migration
    0033).
  - **`crawl.maxUrlLength`** (default and maximum 2,500, the index limit `INDEXED_URL_MAX`;
    minimum 256). A longer URL is refused at admission with url-policy's existing
    `too_long` class.
- **No per-subdomain cap (owner, 2026-11-08).** A crawl never leaves the site's own host,
  its `www` twin and `http`/`https` (`isSameOrigin`), so a per-subdomain cap would have
  nothing to limit. Subdomain crawling, with its own cap, goes on the backlog as a later
  feature.
- **Unchanged:** `maxDepth` already exists and is listed here only because the roadmap
  names it.
- **Hard-coded on purpose:** the body cap, fetch timeout, sitemap limits and
  per-origin connections stay as they are. They protect the memory contract and the
  site, not a preference.

### Gate 27c

- Full suite and the harness green, with 0 skipped.
- **The fixture site gains:**
  - a Basic-auth area;
  - a cookie-gated page;
  - a header-gated page;
  - a redirect chain longer than 10 hops.

  Each feature has positive and negative tests, including credentials not crossing to
  another host and not following a redirect off the site family.
- **The secret scan passes,** and a restart test shows `CREDENTIALS_REQUIRED` rather than
  401 rows.
- **On a list crawl of the fixture site:** every listed URL is classified, the spider-only
  rules are marked by `crawl.list-mode`, and no rule fires because of the missing graph.
- **The 50k gate is re-run** with an `exclude` pattern set, because admission is now on
  the hot path. The peak must stay at or below 512 MB and within 5% of the 27b run.
- **A small live list crawl of lavishalice** (about 50 URLs, owner OK needed first),
  with the findings reviewed for false positives.

---

## Surface

New tools and routes:

| Tool | Route | Sub-phase |
|---|---|---|
| `issues_overview` | `GET /crawls/:id/overview/issues` | 27a |
| `crawl_overview` | `GET /crawls/:id/overview/crawl` | 27a |
| `crawl_pause` | `POST /crawls/:id/pause` | 27b |
| `crawl_cancel` | `POST /crawls/:id/cancel` | 27b |
| `crawl_delete` | `DELETE /crawls/:id` | 27b |
| `config_schema` | `GET /config/schema` | 27b |
| `config_validate` | `POST /config/validate` | 27b |
| `crawl_config_get` | `GET /crawls/:id/config` | 27b |
| `crawl_config_set` | `PATCH /crawls/:id/config` | 27b |

Two CSV views are new: `issues_overview` and `crawl_overview`.

Changed fields, all additive:
- **`issues_list` items** gain `type` and `priority`. Every listing gains
  `disabledRules`.
- **`rules_catalog`** gains `type`, `priority` and `disabled`. Given a crawl id, it also
  gains the overridden values and the thresholds the crawl was judged with.
- **`crawl_status`** gains `judgementStale`, `controlRequested`, `cancelledAt`,
  and `excludedDropped`.

**Docs and skills.**
- **`docs/talos-surface.md`** is updated in each sub-phase:
  - every new tool, response shape and refusal;
  - §10: priority, and the command tools. The doc says four, but there are five today
    (`crawl_start`, `crawl_resume`, `crawl_render`, `crawl_rules`, `crawl_mark_failed`);
    there will be nine, with pause, cancel, delete and `crawl_config_set`;
  - §9: delete, and tenancy.
- **`docs/talos-integration.md`** obligation 6 gains one sentence on default triage
  versus agent overrides.
- **The skills:**
  - **`ariadne-audit`:** reads type and priority as the rule's opening bid, alongside
    severity. Disabling a rule becomes the way to record "doesn't apply here".
  - **`ariadne-action-plan`** and **`ariadne-report`:** take engine priority as an input
    to their own site-level priority, not a replacement for it. Each skill keeps its own
    ladder.
  - **`ariadne-crawl`:** gains pause, cancel, list mode and the schema tools.

## Non-goals

- **No robots override, at all.** Politeness (hard rule 9) is not configurable.
- **No form-login or session flows, and no JavaScript-driven login.** Basic auth,
  cookies and headers cover staging sites and pre-issued sessions.
- **No proxies, and no regular expressions in patterns.**
- **No pausing or cancelling a render pass or rules run in progress.** They are refused
  while running.
- **No tenant scoping, scheduling or webhooks.** Those are Phase 28.
- **No overriding severity.**
- **No storing credentials, encrypted or not.**

## Calls I made (owner to check)

1. Follow the roadmap and add type × priority, despite Phase 16's rejection. The
   override layer is what makes it compatible with obligation 6.
2. Type and priority are referenced to Screaming Frog's own Issue Type and Priority,
   taken black-box from an SF run, where a rule maps to an SF issue. The rubric covers
   the rest, and the gate doc lists divergences.
3. Markers are type `warning`, priority `low`. Metric rules have no type or priority.
4. Severity cannot be overridden. Only type, priority, disabled and thresholds can.
5. Disabling, retyping and reprioritising take effect at read time. Thresholds take
   effect at the next rules run, with `judgementStale` shown in between.
6. Split into 27a, 27b and 27c, judgement first, each with its own gate.
7. Pause and cancel go through a database column polled by the loop, so they will still
   work with Phase 28's multiple workers. A shutdown becomes a pause (`pauseReason`), and
   stored `cancelled` crawls are relabelled. `cancelled` then means only "an agent
   cancelled it", and that is final.
15. A rules run executes disabled rules too, so re-enabling one is instant.
    `judgementStale` covers the disabled set, the thresholds and `findingCap`, but not
    retyping.
16. Cancel skips the resource and recheck passes, and their checks stay "not measured".
17. Paused crawls can be rendered and judged. While that runs, resume, cancel, delete and
    crawl-field config changes are refused.
18. Changing excludes or includes while paused re-filters the unfetched frontier on
    resume.
19. Delete also removes the crawl's files on disk.
8. Delete is a hard delete, with a `confirm` echo of the crawl id.
9. Config is one zod 4 schema with a generated JSON Schema. It replaces both of today's
   parsers, and the existing refusal codes are kept.
10. List mode accepts up to 10,000 URLs on one site family. Site-wide rules are marked
    "not measured" by one `crawl.list-mode` marker.
11. Excludes and includes use anchored `*` wildcards, not regular expressions. Refused
    URLs are recorded as `excluded` rows, within the blocked-URL budget.
12. Credentials stay in memory only and are re-supplied after a restart. They are sent
    only to the site's own hosts. `Set-Cookie` is ignored.
13. The page crawl's redirect cap is new, with a default of 10.
14. The overridable thresholds are site preferences only. Engine internals and protocol
    limits are fixed.

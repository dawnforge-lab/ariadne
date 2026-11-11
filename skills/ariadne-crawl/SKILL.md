---
name: ariadne-crawl
description: >
  Crawl a site with the Ariadne engine and get it ready to audit: start the crawl,
  poll it to completion, run the render pass and run the rules. Use this skill when
  the user says: "crawl this site", "run a crawl", "start a crawl of", "crawl it with
  Ariadne", "re-crawl the site", "is the crawl finished", "check the crawl", "how far
  along is the crawl", "the crawl is stuck", "run the rules on that crawl", "render
  the crawl", "we need fresh crawl data". It is also the first phase of an audit —
  the ariadne-audit skill calls it before walking the checklist. It needs a running
  Ariadne server (MCP or HTTP) whose allowlist covers the target host; it does not
  crawl anything itself.
---

# Ariadne — crawling a site

Ariadne is a crawl-and-audit engine. This skill drives its crawl half: one site in,
one judged crawl out, identified by a `crawlId` that everything downstream reads.

The engine produces facts and no judgement. Nothing here decides whether a site is
healthy; it decides that the evidence is complete enough to judge, which is a
different job and the one that goes wrong silently if nobody does it.

## Prerequisites

Check all five before starting. Each failure has a person who can fix it, and none
of them is worked around.

1. **A server is running.** Either transport, over the same service:
   - `npm run mcp:serve` — MCP on stdio, the preferred surface. Twelve tools,
     no token: an stdio client is the process that started the server. It needs
     `ARIADNE_TENANT` (Phase 28a; the one tenant this process acts for, for example
     `local`) and refuses to boot without it.
   - `npm run api:serve` — HTTP on `127.0.0.1:8787` by default, bearer token
     required (`ARIADNE_API_TOKEN`, 16 characters minimum), plus an
     `X-Ariadne-Tenant` header on every request.
   Both need `DATABASE_URL`. Neither invents one.
2. **The target host is on the allowlist.** `ARIADNE_ALLOWED_DOMAINS` is a
   comma-separated list of bare hosts (`example.com`) or subdomain wildcards
   (`*.example.com`). An empty list refuses every crawl and answers every query.
3. **Every legacy host is on it too**, separately, if you plan to pass
   `legacyHosts` — the probe fetches those before it has read anyone's robots.txt.
   Same for a `sitemapUrls` document that lives off the site's own hosts (a CDN,
   a subdomain): the discovery walk fetches every document it is handed.
4. **Chromium, if you intend to render.** The render pass drives a real browser
   through Playwright: `npx playwright install chromium`, once per machine. Without
   it `crawl_render` fails at launch, and it fails UNHELPFULLY — a missing browser is
   not one of the render pass's own refusals, so it surfaces as
   `{"error": "internal error", "correlationId": …}` with the reason in the server's
   log. Install it before the first render rather than diagnosing that.
5. **Permission to crawl.** We crawl client sites with consent. If nobody has said
   yes, stop and ask; this is not a technical prerequisite you can satisfy with a
   flag.

If the host is not on the allowlist, `crawl_start` refuses with a message saying so.
**That is policy, not a fault**: do not retry, do not try a different spelling of the
host, do not seed at a subdomain to get around it. Ask the operator to add the domain.

## MCP first, HTTP as the fallback

Speak MCP when it is there. The HTTP routes exist for callers that cannot hold a
stdio client (and are the seam a future Talos integration uses), and they answer the
same JSON:

| MCP tool | HTTP |
|----------|------|
| `crawl_start` | `POST /crawls` |
| `crawl_status` | `GET /crawls/:id` |
| `crawl_list` | `GET /crawls` |
| `crawl_render` | `POST /crawls/:id/render` |
| `crawl_rules` | `POST /crawls/:id/rules` |
| `crawl_resume` | `POST /crawls/:id/resume` |
| `crawl_mark_failed` | `POST /crawls/:id/fail` |
| `issues_list` | `GET /crawls/:id/issues` |
| `issue_urls` | `GET /crawls/:id/issues/:ruleId/urls` |
| `issue_inlinks` | `GET /crawls/:id/issues/:ruleId/inlinks` |
| `metrics_get` | `GET /crawls/:id/metrics` |
| `pages_query` | `GET /crawls/:id/pages` |
| `robots_get` | `GET /crawls/:id/robots` |
| `export_crawl` | `GET /crawls/:id/export` |

Over HTTP every request carries `Authorization: Bearer $ARIADNE_API_TOKEN` and
`X-Ariadne-Tenant: <tenant>`; a crawl of another tenant answers 404 as a missing one. Filters
are query parameters with the same names, and an unknown parameter is a 400 naming
it rather than an ignored filter.

## Step 0 — is there already a crawl?

`crawl_list` answers newest first: `{crawlId, siteUrl, status, startedAt, finishedAt,
pagesCrawled, renderPassCount}`. A crawl of this site from this morning is usually
better than a fresh one an hour from now, and a site does not enjoy being crawled
twice in a day. Re-crawl when the site has changed, when the last crawl stopped
short (`status` not `finished`), or when the audit needs a render pass the old crawl
never got.

## Step 1 — start it

`crawl_start` with `siteUrl`, and as little else as the job allows. It answers
`{crawlId, status, queuePosition}` immediately: the crawl is QUEUED, not finished,
and one crawl runs at a time per server. `queuePosition: 0` means it is starting now.

Fields worth setting deliberately:

- **`maxPages`** — defaults to 500, which is a first look at a site rather than an
  audit of one. Raise it to cover the site: a crawl that hits its cap leaves the
  frontier undrained, and several checks then read "we ran out of budget" as if it
  were a fact about the site. It is real load on someone's server, so size it, don't
  max it.
- **`maxDepth`** — leave unset unless you mean to truncate. The cap is on DISCOVERY
  depth (hops from a seed), and truncating it truncates two different reports: the
  `structure.depth-distribution` metric, and — because a page the crawl never fetched
  has no link graph — the click depth the rules compute afterwards
  (`structure.click-depth-distribution`, `pages_query`'s `clickDepth`). Pages cut off
  by the cap read as unreachable, which is a fact about the crawl wearing the shape of
  a finding about the site.
- **`probeHosts`** — on by default, and the only evidence behind the host checks
  (apex vs www, http vs https, legacy hosts). Turning it off makes those checks
  unanswerable rather than clean.
- **`legacyHosts`** — hosts the site used to live on. Each must be allowlisted in its
  own right; they are different sites by every definition the engine has.
- **`sitemapUrls`** — sitemap documents to walk beyond the ones robots.txt declares.
  See "The sitemap has two paths" below; leave it unset when robots.txt declares the
  sitemap, which is most sites.
- **`renderBudgetPct` / `renderMaxPages` / `renderSamplePerType`** — the render
  pass's sample, stored on the crawl row now and read by the render pass later. Set
  them here if the default sample would not cover the page types you care about.
- **`findingCap`** — how many findings each listing rule may report when this crawl
  is judged. Defaults to 200: a bounded first look.
  **Set `findingCap: null` for a billed audit** — the client is paying for the whole
  picture, and "243 orphans, here are 200" is not a list they can finish. Like the
  render knobs it is stored on the crawl row and spent later: `crawl_rules` has no
  cap argument. Set it HERE when you know; if you did not, `crawl_config_set` can
  change it afterwards (see "Changing how the crawl is judged" below) and the next
  `crawl_rules` applies it — no re-crawl. Measured cost on a 20,000-page crawl: about
  a minute of extra rules time, ~116MB RSS. See the audit skill's "Reading the
  answers" for the one shape where uncapped is genuinely expensive
  (`content.near-duplicate` on a site with thousands of byte-similar pages).
- **`judgement`** — how this crawl will be JUDGED from its first rules run:
  `{rules?: {<ruleId>: {disabled?: true, type?, priority?}}, thresholds?: {<name>:
  number}, findingCap?}`, the same block `crawl_config_set` changes later. Leave it
  unset unless the brief already tells you something the defaults get wrong — a
  client whose title template is deliberately 70 characters (`{"thresholds":
  {"TITLE_MAX": 70}}`), or a rule the client has told you does not apply. It is
  checked against the ruleset before the crawl is accepted, and a block the ruleset
  cannot apply is refused naming the path (severity is never settable). A
  `findingCap` inside `judgement` must agree with a top-level `findingCap` if you
  give both.

### The sitemap has two paths, and only two

**Declared.** robots.txt carries a `Sitemap:` line, the walk follows it, and there is
nothing to do — this is most sites.

**Undeclared.** The site publishes a sitemap and never points at it. Pass its URL in
`sitemapUrls` at crawl start; the walk reads it beside the declared ones, follows a
sitemap index three levels deep, and its entries become sitemap entries of the crawl
like any other. Full http(s) URLs, absolute — a relative path is a 400 naming the
entry, and a host outside the site's own spellings (apex/www × http/https) must be on
the allowlist in its own right, because the walk fetches every document it is handed.

A slow sitemap is waited for: a document gets 60 s for its headers, 30 s of silence
mid-body and 120 s in total across its redirects, and the whole walk 10 minutes. A
document that breaks a limit is a failed sitemap and says which one (`no headers
within 60 s`, `no data for 30 s`, `over 120 s in total`; read them in `sitemap.structure`'s
Failures column). A walk that ran out of its 10 minutes is `timeLimited` in
`hreflang.declarations-incomplete`: the entries read are kept, the rest unread, so the
hreflang rules that need the whole sitemap did not run (NOT MEASURED, never a pass).

**There is no third path: the engine never probes for a sitemap URL on spec.** A
document nobody pointed at is a request somebody has to decide to make, and reporting
whatever comes back as the site's published sitemap would be a fact the crawl made
up — a guessed 200 from a CMS catch-all route would enter the evidence as a sitemap
the site publishes. So when a crawl reports **`sitemap.missing` (CHECK-06 — "robots.txt
declares no sitemap")** and `crawl_status` shows an empty `sitemapUrls`, the honest
next step is to **ask where the sitemap is** (the site owner, the CMS, the usual
sitemap paths in a browser, Search Console) and re-crawl with `sitemapUrls` set. Do
not report the site's sitemap coverage from a crawl that never read its sitemap.

Supplying the URL does **not** hide the finding, and must not be used to: robots.txt
still declares nothing, `sitemap.missing` still fires, and the fix — one `Sitemap:`
line — is still the site's to make. `robots_get` keeps the two provenances apart:
`sitemapSources` are the `Sitemap:` lines the file carried, `suppliedSitemaps` are the
documents this crawl was handed. A document in both was declared and re-supplied; the
walk fetched it once.

**`userAgent`**, **`perHostDelayMs`** and **`maxConcurrency`** are the politeness
settings, not tuning knobs for speed. The user agent must stay identifiable, and
robots.txt's own `crawl-delay` wins over `perHostDelayMs` when it is longer. The only
direction you may ever move the other two is **slower**, and the platform table below
is when to do it.

### List mode, scope patterns and credentials

Three things a crawl can be told since Phase 27c. Each is checked at start, and
`config_validate` answers every refusal without starting anything: run it first.

**List mode — check a known set of URLs, not the site.** `mode: "list"` with `urls`
(1 to 10,000, every one on the site's own hosts: its host or the www/apex twin, http or
https) fetches exactly those URLs at depth 0, follows each one's redirects to a
classified row (within `maxRedirectHops`), records links without following them,
obeys robots.txt, and reads no sitemap unless you pass `sitemapUrls` (never `[]`:
omit the key to read none). Beside the list it also requests the host probe (the site
root on up to four spellings; `probeHosts: false` turns it off) and the known-404 probe
(one random path), and the 5xx recheck, the resource pass and the render pass run as
configured: re-checking five URLs on a fragile site, turn off what it should not see.
`maxPages` defaults to twice the distinct list. The answer
adds `listUrlCount` and `listDuplicates`; two spellings of one URL are crawled once
and counted. Use it to re-check the URLs a previous audit flagged, a migration's
redirect map, or a client's priority pages. **It is not an audit of the site**: the
rules that need the whole site (orphans, click depth, inlinks, sitemap coverage) do
not run, and `crawl.list-mode` names them — see the audit skill before quoting any
list-crawl finding, or the absence of one.

**Scope — fence part of the site off.** `exclude` and `include` are URL patterns
matched against the whole URL, `*` for any run of characters and nothing else
special: `*/cart*` and `*?sort=*` are path and parameter rules,
`https://example.com/blog/*` a host-and-path rule. The match starts at the URL's first
character, so **a path rule needs its leading `*`**: `/cart*` can never match and is
refused. Exclude wins; a non-empty `include` admits only what matches it. A refused
URL is never fetched: it is a page row of fetch class `excluded` whose `fetchReason`
names the pattern, and past the shared budget it is counted in
`crawl_status.excludedDropped`. A seed or listed URL the scope refuses, and a pattern
that can never match (no leading `*` and no `http://`/`https://`, a host that is not
the site's, or `http://` on an https site), are refused at start and by
`crawl_config_set` (an empty crawl is not an answer). Fence off only what the brief
says to: every excluded URL is a part of the site the audit does not see, and the
findings file must say so.

**Credentials — staging sites and gated pages.** `requestHeaders` (up to 20; not
`host`, `user-agent`, `accept`, `accept-encoding`, `content-length`, `connection`,
`transfer-encoding`, `te`, `upgrade`, `expect`, `keep-alive`, `cookie`,
`authorization`, or any name starting `proxy-` or `sec-`), `httpAuth`
(`{username, password}`, Basic) and `cookies` (up to 50 `{name, value}`). A
refusal never quotes a name that is not an HTTP token (it names its position): a
value pasted into a name is not echoed back. They go only to the site's own hosts, never to a
CDN, another host or a redirect that leaves the site, and an https site never sends
them over http. They cannot change the user agent, the delay floor or robots.txt.
**The engine never stores them**: they live in the server's memory, `crawl_config_get`
shows the names with every value `"[redacted]"`, and a cancel or delete drops them.
**The restart rule:** after the server restarts it no longer holds them, so
`crawl_resume` and `crawl_render` refuse with code `CREDENTIALS_REQUIRED` (409) until
you send the same kinds and names again on that call. Keep the values where you got
them for as long as the crawl may be resumed or rendered. A gated page fetched without
its credential is a `blocked` row (401 or 403), never a silent gap. Credentials cannot
be added on a resume or a render to a crawl that started without any: set them with
`crawl_config_set` while the crawl is paused.

**Changing them while paused.** `exclude`, `include`, `maxRedirectHops` and the three
credential fields are `whenPaused`: pause, `crawl_config_set`, resume. A changed scope
stamps `scopeChangedAt`, and the resumed run re-files before its first fetch, both
ways: pending URLs the new lists refuse become `excluded` rows, and `excluded` rows
they now admit are queued again within `maxPages`. Pages already fetched stay. `mode`,
`urls` and `maxUrlLength` never change after the start.

### Pacing by platform

Most e-commerce sites sit behind a WAF running a token bucket: it is not counting your
requests, it is counting how bunched they are. Defaults are for an ordinary origin.

| The site is… | How to tell | Start with |
|---|---|---|
| Shopify, or anything Cloudflare-fronted | `cdn.shopify.com` assets, `x-shopid`, `myshopify.com` redirects; `cf-ray` / `server: cloudflare` on any response | `maxConcurrency: 2`, `perHostDelayMs: 2000` |
| Same, and `blockedPages` is climbing mid-crawl | see Step 2 | stop, re-crawl at `maxConcurrency: 1`, `perHostDelayMs: 2000` |
| Anything else, no evidence of a WAF | — | leave the defaults |

Screaming Frog crawls a Shopify store at 2 threads and 1 URL/second for the same
reason, and 1000 ms was this table's first Shopify row. **The Phase 6 gate moved it.**
On a Shopify/Cloudflare store started at 1000 ms the engine's own ratchet doubled the
spacing to 2000 ms within about a hundred pages and held it there for the remaining
85% of the crawl — a clean run, zero blocked pages, but 2000 ms was the site's answer
and the first hundred pages were the question. The engine will earn the right number
on its own; starting at it is simply politer, and it makes the ETA you quote the ETA
you get. One real data point, not a law: record what the next Shopify crawl settles
at. The Phase 24a gate recorded the next one. On lavishalice the engine's Shopify profile
ran one request in flight at 1000 ms, the store 429'd twice, and the crawl settled at
2000 ms (`throttle`: 2 × 429, one recovery, then locked). So 2000 ms is still the right
start. Since 24a the profile clamps `maxConcurrency` to 1 on a detected Shopify store
whatever you pass, so the row's `2` only matters when the store's headers hide the
platform (`platform: null`).

**Do the arithmetic before you promise anyone a time, and do it on
`perHostDelayMs` alone.** The per-host gate serialises every request to one host at
that spacing, so a single-site crawl takes about `maxPages × perHostDelayMs`
regardless of `maxConcurrency`:

| Pages | `perHostDelayMs` | Roughly |
|---|---|---|
| 2,000 | 1000 | 33 minutes |
| 2,000 | 2000 | 67 minutes |
| 500 | 1000 | 8 minutes |

`maxConcurrency` does **not** buy throughput on a single-host crawl. It bounds how
much work is in flight — which bounds memory and, more importantly, burstiness — and
a site behind one hostname is paced by the gate whatever it is set to. Raising it to
go faster changes nothing except how bunched the requests are, which is the thing WAFs
actually count.

Do not raise either setting to make a crawl finish sooner. If it is too slow to be
practical, crawl fewer pages (`maxPages`), not faster.

There is no `allowPrivate` on this surface at any value. The schema refuses it as an
unrecognised field and the service refuses it again by name. A loopback or RFC1918
target is not something this skill can crawl.

## Step 2 — poll it

`crawl_status` is the polling tool:

```
{crawlId, siteUrl, status, startedAt, finishedAt, pagesCrawled, pagesTotal,
 renderPassCount, rulesetVersion, controlRequested, pauseReason, cancelledAt,
 neverFetched, failureReason, legacyHosts, sitemapUrls, findingCap,
 frontier: {pending, leased, done, failed, renderPending},
 queuePosition, job, liveLeases, blockedPages, hostSpacingMs, throttle,
 platform, platformProfile,
 robotsBlocked: {recorded, dropped}, excludedDropped,
 rulesRunAt, judgementStale, findingsCount, pagesScanned, fetchResources,
 resourceRefsCappedPages,
 resources: {seen, fetched, failed, skipped, robotsDenied, robotsUnreachable,
             capped},
 recheck: {serverErrors, confirmed, cleared, inconclusive, pending,
          noResponse: {pages, confirmed, answered, inconclusive, pending},
          capped, passAt}}
```

What the fields mean when you are waiting:
- **`controlRequested`, `pauseReason`, `cancelledAt`, `neverFetched`** (lifecycle,
  written by `crawl_pause`, `crawl_cancel` and the loop that acts on them):
  `controlRequested` is a pause or cancel asked of a running crawl, `pauseReason`
  is `request` or `shutdown` on a `paused` crawl, `cancelledAt` and `neverFetched`
  (the frontier's `pending`) are set only on a `cancelled` crawl; each is null
  otherwise. `neverFetched` is null too on a crawl cancelled while still queued:
  it never ran, nothing was seen, and the count is unknown, not 0.

- **`status`** — `queued`, `running`, `paused`, `finished`, `cancelled`, `failed`.
  `finished`, `failed` and `cancelled` are closed; `cancelled` is **final** (it
  cannot be resumed), `paused` is resumable. A server shutdown leaves a crawl
  `paused` with `pauseReason: "shutdown"`, never `cancelled`. While
  `controlRequested` is non-null on a `running` crawl the stop has been asked for
  but not yet delivered: poll again, and do not call `crawl_resume` (it refuses
  with 409 while a request is pending).
- **`failureReason`** — why a `failed` crawl failed: one sentence, and `null` on
  every crawl that is not `failed`. **Read it before you re-run anything.** A
  crawl refused before it began carries the classified sentence — `robots.txt
  unreachable after 3 attempts (HTTP 502): complete disallow` is a host that
  could not serve its own robots.txt, which RFC 9309 makes a complete disallow,
  and re-running it changes nothing until that host answers. A crawl that threw
  mid-run carries the first line of what threw. A crawl somebody retired with
  `crawl_mark_failed` says so in those words. **`null` on a `failed` crawl is not
  "no reason"** — it is a row this engine closed before the field existed. It is
  a diagnostic sentence and not client copy: quote it in a handover note, not in
  a report.
- **`frontier.pending` + `frontier.leased`** — URLs still to fetch and URLs in
  flight. This is the progress bar: `pending` falling while `done` rises is a healthy
  crawl, however slow.
- **`pagesCrawled` — it stays at 0 until the crawl ends.** The column is written when
  the crawl closes, so it reads 0 through the whole run and jumps to the final count
  at the end. It is not a progress counter and a crawl showing 0 after sixteen minutes
  is not stuck. **`frontier.done` is the live number**; watch that one.
- **`liveLeases`** — unexpired worker leases. A live crawl BETWEEN BATCHES
  momentarily holds none, which is exactly the window an impatient caller looks in.
- **`queuePosition`** — a number only while the crawl is `queued` with a job waiting
  to run it (0 = starting now), null otherwise. `status: "queued"` with
  `queuePosition: null` is the one genuinely broken state: no job will run it. Hand it
  to `crawl_resume`, which picks up the same crawl, or retire it with
  `crawl_mark_failed`.
- **`job`** — the engine's work item behind the status: the crawl's latest crawl run,
  render pass or rules run, with its own status and the engine process that took it,
  or null when none ever ran. `status` stays the crawl's truth; `job` says who is (or
  was last) working on it.
- **`rulesetVersion`** — stamped when the crawl was ACCEPTED. It does not tell you
  whether the rules have run.
- **`renderPassCount`** — despite the name, it is **how many pages the last render
  pass that launched rendered**, not how many passes ran (a pass that could not start
  leaves it unchanged). `≥ 1` means a render pass happened; **`0`
  does not mean one did not** — a pass that rendered nothing and a crawl nobody ever
  rendered both leave 0 here. `render.coverage`'s `renderPassEvidence` is the field
  that separates them, and `crawl_render`'s own `selection` block is the other place
  the real coverage lives. `renderPassEvidence: "failed"` means the LAST render pass
  could not start: `renderLaunchError` says why, the pages it selected stay pending,
  and calling `crawl_render` again retries them. Pages an earlier pass rendered
  (`pagesRendered` or `renderFailures` above 0) are still that pass's evidence and its
  findings stand; only what no pass rendered is NOT MEASURED, and everything is when
  both counts are 0. Never read `failed` as rendered or as no render needed. The name is on the backlog.
- **`blockedPages`** — pages a WAF or rate limiter answered instead of the site
  (401, 403, 429, or a challenge page). Watch it across polls: the number matters far
  less than whether it is still rising. See the reaction loop below.
- **`robotsBlocked`** — not a block by the site: internal URLs the site's own
  robots.txt disallows, which this crawl never requested. `recorded` are on record as
  pages (`robots.blocks-internal-urls` lists them with their inlinks); `dropped` counts
  discoveries turned away once their own budget (default `maxPages`) was full — not
  distinct URLs — and non-zero means that rule's list is incomplete. `dropped: null`
  is a crawl from before this was counted, not zero. That budget is the crawl
  config's `maxBlockedUrls`; `crawl_start` does not accept it, so every crawl you
  start gets the default, and a site whose robots.txt blocks more internal URLs than
  `maxPages` will report `dropped > 0`.
- **`excludedDropped`** — discoveries the crawl's own URL scope patterns (`exclude` /
  `include`) turned away once the excluded-row budget was full; a count of
  discoveries, not distinct URLs. `null` is a crawl from before this was counted,
  not zero. Our decision, not the site's: it is not a block.
- **`hostSpacingMs`** — how far the engine has already backed off: the widest gap it
  is enforcing between two requests to one host, in milliseconds. It starts at the
  crawl's `perHostDelayMs` and rises when a host pushes back; since Phase 24a it can
  also come back down, because a host that stops pushing back is stepped down one level
  per run of clean responses. Null means no crawl loop reported one
  (an old row, or a crawl that failed before it fetched anything) — which is not the
  same as `0`.
- **`throttle`** — the per-host record behind `hostSpacingMs`, keyed by host:
  `responses429`, `retryAfterSeen`, `escalations`, `recoveries`, `recoveryLocked`,
  `peakSpacingMs`, `finalSpacingMs`. `escalations` is cumulative, so the level in force
  is `escalations - recoveries`. `recoveryLocked: true` means the host pushed back
  again after it had recovered, so it stays at its spacing for the rest of the crawl.
  It is evidence about how the site received the crawl, not a finding: report it as
  "the site throttled us, here is how", never as a defect to fix. Every host the crawl
  touched is in it, including hosts with all-zero counters. Null means no record was ever
  stored (the crawl predates the field, or failed before its first write) — that is
  not the same as "nothing throttled it". `{}` means a crawl that touched no host.
- **`platform` and `platformProfile`** — the platform the site's own response headers
  named, and what that did to the crawl. `platform` is `"shopify"` (a `powered-by:
  Shopify` header, or any `x-shopify-*` header, on the first `ok` HTML page from the
  crawl's origin) or `null`. Detection reads headers only, so a Shopify store whose CDN
  strips those headers shows `null`. `null` means the crawl ran at the settings you
  gave it. `platformProfile` is `null` exactly when `platform` is. Otherwise `applied`
  holds what the crawl actually ran at after the profile: `maxConcurrency`,
  `perHostDelayMs`, `renderConcurrency`, `navigationTimeoutMs`. A profile only ever
  slows a crawl down. Shopify means 1 request in flight, at least 1000 ms per host,
  1 render browser and a render navigation budget of at least 60 s. A setting you gave that was
  already slower stands. So a Shopify crawl started at `maxConcurrency: 16` runs at 1:
  that is the engine, not a bug, and a smaller `maxPages` is how to make it finish
  sooner. `appliedAt` is when the profile took effect. It is mid-crawl when no host
  probe ran, and requests already in flight then finished at the old settings.
  `optedOut: true` (with `applied` and `appliedAt` null) means the operator turned
  profiles off for this crawl, so nothing was clamped. You cannot opt out from
  `crawl_start`. This is crawl configuration, not a finding about the site.
- **`resources` and `fetchResources`** — what this crawl knows about the images,
  stylesheets and scripts its pages point at, counted off the database rather than
  reported by any one pass (a resumed pass asks only what is still unfetched, so its
  own report would say it fetched nothing). `seen` is the distinct files the served
  HTML references; `fetched` is the files a server answered about; `failed` is the
  files it could not answer for — a 4xx, a request that failed, a URL our policy
  refused, a file robots.txt put out of reach — and `skipped` is SEEN BUT NOT ASKED.
  `fetched + failed + skipped = seen`, always. `capped: true` means a resource
  budget stopped the pass short — those budgets are per RUN, not per crawl, so a
  resume re-grants them (see `crawl_resume`). `robotsDenied` and
  `robotsUnreachable` are two
  subsets of `failed` and are not part of that sum: `robotsDenied` is "they said
  no" — the host served its robots.txt and it forbids us — while
  `robotsUnreachable` is "we could not ask" — the host answered 5xx, timed out or
  failed at the network, which is a complete disallow all the same. The behaviour
  was identical either way (no request was made), and the report is not:
  `robotsUnreachable` is usually a third party's CDN briefly down rather than a
  policy anybody chose. Each row's `fetchReason` on the `resources` CSV view names
  the host and the reason. A crawl run before the two were split has every robots
  refusal in `robotsDenied`. `fetchResources` is whether
  the crawl asked at all: `false` is an operator's decision, and beside `fetched: 0`
  it means nobody weighed anything rather than that nothing is heavy.
- **`recheck`** — the second look at this crawl's server errors. Every page whose
  first fetch ended 5xx is asked once more at the end of the crawl, at least a
  minute later, because a 5xx seen once may be a blip rather than a broken page.
  `serverErrors` is how many pages answered 5xx the first time, and four numbers
  partition it: `confirmed` (5xx again), `cleared` (the site answered something
  that is not a 5xx — the transient case, and the only thing that turns an Error
  into a Warning), `inconclusive` (asked, no answer about the page: a timeout, a
  network failure, a block, or a URL our policy or robots.txt refused) and
  `pending` (never asked). `confirmed + cleared + inconclusive + pending =
  serverErrors`, always, and the counts are read live off the pages — so
  `pending` falling is the pass working while you poll. `capped: true` means the
  pass's own 500-row budget stopped it short; those rows stay in `pending`.
  `noResponse` is the same second look over URLs that got no HTTP response at all
  (timed out, or the connection failed), in a block of its own because the partition differs:
  `{pages, confirmed, answered, inconclusive, pending}`, where `answered` is ANY
  HTTP reply on the second look (a 5xx or a block too: the URL responded),
  `inconclusive` means no second request was made because robots.txt or the
  crawler's own URL policy refused it, and
  `confirmed + answered + inconclusive + pending = pages`. Those rows are in none of
  the five 5xx numbers. The walk has its own 100-row budget (counted in `capped`
  and `pending`), runs after every 5xx, and a per-host breaker stops asking a host
  after three consecutive rechecks that still get no response (rows the breaker
  skips stay in `pending`; no separate count is served). Bodies over 2 MiB are not read at all: such a 2xx page is classed
  as too large and reported by `page.html-too-large`, not re-checked.
  `passAt` is when a COMPLETE pass finished, and **null there is "nobody looked",
  not "nothing to look at"** — those pages keep their Errors, and their evidence
  says `recheck: "not run"`.

- **`resourceRefsCappedPages`** — how many of the crawl's PAGES carried more
  resource REFERENCES than the analyzer's cap keeps (2,000 per page, the rest
  turned away). References, not files: past the cap the analyzer stops resolving, so
  a page whose 2,001st reference repeats its first is counted here and lost no file
  at all. On those pages the `seen` count above **may be** a floor — some of the
  turned-away references would have been files nobody recorded — so a count over the
  census may be a count over a sample of that page's references. Which pages that is
  actually true of is not knowable from any surface. **`null` is not `0`**: null
  means nobody counted (a crawl older than the counter, one still running, or one
  whose process died before its first close — that null is permanent, a later resume
  cannot recover the pages the dead run read), while `0` means every page was read
  and none of them lost a reference. Do not report the two the same way, and do not
  divide this by `pagesCrawled`: they are counted off different sources and a ratio
  above 1 is legitimate on a crawl that analysed one URL twice.
- **`rulesRunAt` and `findingsCount`** — the judged marker, and the only pair that
  tells an empty findings listing from an unjudged crawl. `rulesRunAt` is when a rules
  pass last COMPLETED (null: none on record — never judged, being judged now, or a run
  that died part-way); `findingsCount` is the crawl's findings, counted live. A
  timestamp with zero findings is a clean site; a null with any number is a partial
  pass to re-run. They are on the crawl, so an auditor who never met your session can
  read them. Neither moves during the crawl itself — the rules cannot run until it
  stops.
- **`pagesScanned`** — how many pages a rules pass over this crawl reads. It describes
  the CRAWL, not a run, so it is answered before anybody judges it, and it is the same
  number `crawl_rules` reports as its own `pagesScanned`. It is the denominator a
  finding count is written against, and it is why an audit of a crawl somebody else
  judged does not need a second pass to describe the first. Not `pagesCrawled`: that
  is the crawl loop's own counter of what it fetched.
- **`legacyHosts`** — the extra hosts this crawl was told the site used to live on,
  echoed from its stored config. Empty means none were given, which is what separates
  "the legacy domain does not redirect" from "nobody named a legacy domain" in
  CHECK-15.
- **`findingCap`** — what this crawl's listing rules will be cut at when the rules
  run. `200` is the default (nobody chose); `null` is uncapped, the billed-audit
  setting; a number is what was set. **Check it before running the rules on client
  work**: the cap lives on the crawl row and `crawl_rules` has no argument to restate
  it. A billed audit started at the default is fixed with `crawl_config_set`
  (`{"judgement": {"findingCap": null}}`) before `crawl_rules`, not with a re-crawl.
  A reported `200` does not distinguish an explicit `findingCap: 200` from an absent
  one, and since Phase 19 §11 there is nothing to distinguish: one budget, so the
  stated default and the absent one judge identically.

Poll every 15-30 seconds early and back off to a minute on a long crawl; there is
nothing to gain from tighter polling, since the crawl's pace is set by politeness
rather than by anything you can ask for.

### When `blockedPages` climbs

The engine protects itself before you get a chance to. A refusal that names a rate — a
429, or anything carrying a `Retry-After` — **doubles that host's spacing** (1s → 2s →
4s → 8s, up to 30s), and a volley of refusals that named no rate (403s across several
different URLs) does the same once it is clearly about the host rather than about one
forbidden page. A `Retry-After` is honoured as a floor under the next request, and each
blocked URL is **retried up to three times** under the widened spacing — so a page
refused during a burst is usually served once the crawl has slowed down.

Since Phase 24a the ratchet can wind back, a bounded amount. After 50 clean answers in
a row from a host (a 2xx, 3xx or 4xx other than 429, with no `Retry-After` and not
a 401/403/challenge refusal), that host steps down one level and its spacing halves,
never below where it started. If the host then pushes back again, recovery is locked
for the rest of the crawl and the spacing only goes up from there. So a host's spacing
turns from falling to rising at most once per crawl, and a site that alternates 200 and
429 never recovers at all. `throttle` shows which of these happened: `recoveries` is how
many steps it came down, `recoveryLocked` is whether it then tripped again. A
`hostSpacingMs` that drops mid-crawl is this, not a reset.

**Read `blockedPages` and `hostSpacingMs` together.** One is what the site did; the
other is what the engine did about it. That pair is the whole diagnosis:

| `blockedPages` | `hostSpacingMs` | What it means | What to do |
|---|---|---|---|
| **Still 0** | Above `perHostDelayMs` | The site pushed back and the engine absorbed it completely — the normal healthy case, not a contradiction | **Leave it alone**, and recompute the ETA at the new spacing. Nothing was lost. |
| Rose, now flat | Above `perHostDelayMs`, not at the cap | The back-off found the site's rate and settled | **Leave it alone.** The crawl is slow *because* it worked. Recompute your ETA at the new spacing. |
| Still rising | Still rising | The escalation has not found an acceptable rate yet | Keep polling. Decide when it stops moving. |
| Still rising | Pinned at 30000 | The engine is out of room to back off | Let this crawl finish — its rows are still evidence — then re-crawl at `maxConcurrency: 1`, `perHostDelayMs: 2000`. |
| Rising on that slower re-crawl | — | The site is refusing us, not throttling us | **Stop.** Talk to whoever owns the site about allowlisting our user agent. |

**Row one is the one to internalise: the two fields answer different questions.**
`hostSpacingMs` is the honest signal that the site pushed back; `blockedPages` is the
signal that the engine could not absorb it. A blocked URL that succeeds within its
three retries is never written as a blocked row, so the engine working perfectly reads
as `blockedPages: 0` — the Phase 6 gate crawl doubled its spacing at about page 100
and finished 551 pages with `blockedPages` at 0 throughout. Do not wait for
`blockedPages` to move before believing a site pushed back, and do not read a rising
`hostSpacingMs` as a problem.

Note the ETA consequence in row two: at `hostSpacingMs: 8000` a 2,000-page crawl needs
about four and a half hours, not thirty-three minutes. Re-quote it rather than letting
someone discover it.

On the last row: **do not push harder, do not change the user agent to look like a
browser, and do not crawl from somewhere else.** Being throttled by a WAF is our
problem to solve honestly; working around one is not something this skill does.

A page that is still blocked after its three attempts also counts in
`frontier.failed`, for the same reason a spent timeout does: its own outbound links
were never read, and findings that depend on the link graph are qualified accordingly.

Blocked pages are recorded, not lost: `pages_query` takes `fetchClass` as a filter and
returns each blocked page with its status code and a `fetchReason` saying how many
attempts it took and what the spacing had reached when the engine gave up. That reason
is what to quote when you report a crawl as incomplete. The same listing carries
`discoveredVia` — `seed`, `link`, `sitemap` or `redirect` — so "which of the pages we
never got are ones only the sitemap knew about" is one query rather than a guess.

**A slow crawl is usually the engine being polite, and `hostSpacingMs` says whether
it is.** The pacing is a per-host delay, plus whatever `crawl-delay` robots.txt asks
for, plus whatever the engine has escalated to — and a restart speeds up none of them
while losing what was already fetched. Before concluding anything about a slow crawl,
read `hostSpacingMs` against the `perHostDelayMs` it was started with: higher means
the site pushed back and the engine answered, and the crawl is now correctly slower
(see the reaction loop below). A crawl that is slow at its configured spacing, with
`pending` falling, is simply a large site.

The one genuinely wrong shape is nothing moving at all: the frontier unchanged for
many minutes with `liveLeases` at zero across several polls. That is a stuck worker,
and the answer is Step 5.

## Step 3 — render (before the rules, or not at all)

`crawl_render` re-fetches some of the crawl's pages in a real browser and stores what
JavaScript added. It answers counts:

```
{rendered, failures, unrendered, elapsedMs,
 requests: {paced, fromCache, unpacedNetwork}, unpinnedHosts: [{host, reason}],
 selection: {mode, selected, budget, suspects, sampled, truncated}}
```

Run it when the audit needs to see what a crawler without JavaScript cannot — which
is any site with client-side rendering, and in practice most e-commerce. Four checks
are unanswerable without it: **CHECK-01** (content that only exists after
rendering), **CHECK-02** (JS-only filters), **CHECK-34** (JS-only navigation) and the
JavaScript-redirect half of **CHECK-10**.

Timing is not optional: **after the crawl stops, before `crawl_rules`.** The diff
rules read columns this pass writes, so rules run first means those checks come out
empty on evidence that exists.

It is refused on a crawl that is still queued or running, on one another worker is
already rendering, and on one with no discovery evidence (there would be no robots
`crawl-delay` to honour). It uses the crawl's user agent and picks up each host where
the crawl left it: the spacing the crawl earned, its back-off level and its recovery
lock (the per-host `throttle` record). A site that pushed back during the crawl is not
asked to say so twice.

**Every request the browser makes to the site is paced, not only the pages.** A page's
own scripts, stylesheets and data requests wait the same spacing as a page fetch, one
after another. Images, video, fonts and anything from another domain are never fetched
at all. The browser can reach only the site's own addresses and port, under both the
`www.` and the bare name. It looks up each address once, when the pass starts, and
keeps using it. If the crawl's own name cannot be looked up, or any of its addresses is
a private or internal one, `crawl_render` refuses with an error that starts `the render
pass could not start:` and names the reason. That is a fact about the site's DNS, so
report it as such. If only the other spelling (`www.` or bare) fails, the pass still
runs, and `unpinnedHosts` in the answer names that spelling and why. Pages on it come
back as `policy refusal` render errors. An entry for `www.<host>` whose reason is
`www.<host> has no A or AAAA record` is normal for a site that has no `www` record at
all: nothing is wrong, and nothing is unrendered, because no page of the crawl lives
there. The browser keeps its cache from page to page, so a theme's scripts are fetched
once and then served from the cache without asking the site again. Cookies and stored
data are cleared between pages, so nothing one page sets changes how the next renders.
Each host spelling is paced and recorded under its own name: a `www.` page waits on
what the crawl earned on `www.`, even when the crawl was started on the bare name.
If the site answers a render request with a 429, the engine slows down exactly as it
does during the crawl, and on a crawl with a 24a `throttle` record the 429 shows up in
that record, under the host that answered it (pre-24a records are not written back).

So the time a render takes depends on how many uncached requests the page makes, not
only on the number of pages. At 1 s spacing, a page with 20 uncached scripts and
stylesheets takes about 20 s, and later pages on the same template take a few seconds
once the cache holds the theme. Because every request waits, the navigation budget
grows with the spacing: 15 s plus 30 spacings, at most 120 s. That is 45 s at the
default 1 s spacing, and 120 s from about 3.5 s up. A Shopify store gets at least
60 s. The spacing is the widest one in force when the pass starts, including what the
crawl earned. A page that cannot load inside its navigation budget is recorded as a
failure whose `renderError` starts
`timeout under pacing (N requests paced)`. That means the page was too heavy to render
at a polite pace. It does not mean the site is broken, so do not report it as a site
defect.

`requests` in the answer counts the pass's requests to the site: `paced` waited their
turn (pages included), `fromCache` never reached the site, and `unpacedNetwork` reached
the site without waiting. That happens in two ways. Either the cache was expected to
answer and did not, which happens at most once per URL. Or the page asked the browser
to prefetch another page of the site ahead of time, which the engine cannot switch off.
A few per page is normal on a site that prefetches. A count far above the number of
pages rendered is an engine problem to mention to the operator, not a site problem.

### Rendering key templates

**There are two ways to choose the pages, and on a site you know anything about, the
second is the right one.** Pass no `urls` and the engine chooses: pages whose HTML
looks incomplete, plus a few of every page type, cut to a budget. Pass `urls` and you
choose — the home page and two or three representatives of each real template. The
`selection` block's `mode` says which happened: `auto` or `explicit`.

**Never ask for the whole site.** Rendering every URL to learn what a dozen pages
would have told you is a waste of resources — someone else's server, and hours of
wall time at a polite pace. Rendering is the most expensive thing this engine does;
spend it on the pages that stand for the most other pages.

**The method, in order.** Do not guess a template count; derive it from this crawl:

1. **Read the cohort sizes.** `metrics_get` with `content.metrics-by-type` gives one
   row per page type with how many pages it covers. The big rows are the real
   templates — the ones worth a browser, because a render of one answers for all of
   them. Small rows are usually singleton paths, not templates.
2. **Read the URL patterns beside them.** `pages_query` (filter by `pageType`, or
   just page through) shows the actual paths. A cohort whose members share a shape —
   `/products/…`, `/collections/…`, `/blog/…` — is a template. A cohort of one URL
   that happens to have its own path segment is not, however the typing came out.
3. **Name the pages.** The home page, then 2-3 members of each real template — not
   the first three alphabetically; pick ones that differ (a product in stock and one
   out of stock, a long article and a short one). Add any **one-off that looks
   suspicious**: the automatic mode's triggers are still good signals and you can
   apply them by eye — a big document with almost no words, a page with no title, a
   page that links nowhere.
4. **Then `crawl_rules`**, and read the result: the four render rules, plus the two
   columns the content one compares (below).

```
crawl_render {crawlId, urls: ["https://site/", "https://site/products/a", …]}
```

**The arithmetic.** A four-template site is about 10-15 renders: one home page,
2-3 each of four templates, two or three suspicious one-offs. At a 2000 ms pace
that is under a minute of somebody's server. Compare with the automatic pass on the
same site, which spends its whole budget before it reaches the fourth template.

**What the engine checks before it renders anything you named.** Every URL must
already be a page of that crawl that answered 200 — this pass RE-VISITS pages, it
never fetches a URL for the first time — and one that is not there is refused by
name, so a typo is one round trip from fixed rather than a silent omission. The list
is deduplicated, and a list longer than the crawl's `renderMaxPages` is refused
rather than trimmed: which of your templates to drop is not the engine's decision.

**A named list REPLACES the automatic selection for that pass.** It does not add to
it. Pages an earlier pass rendered keep their measurements, but the pass you just ran
covered your list and nothing else, and that is what `selection` describes.

### When `auto` is still the right answer

First contact with a site nobody has crawled, or a crawl whose types give you no
clear templates at all. The automatic mode is a reasonable answer to "we know
nothing yet"; it is a poor answer to "we know the site has four templates".

Then read the `selection` block rather than the `rendered` count alone: `budget` is
what the crawl's render fields allowed, `suspects` and `sampled` are how the pages
were chosen, and `truncated: true` means the budget cut the selection. A render pass
that covered 20 of 4,000 pages is evidence about 20 pages.

**`truncated: true` also means the sample was decided by page type, so know what the
types are.** Candidates are sampled per page type and the budget cut takes the largest
templates first, which is what makes a handful of renders stand for a whole template.
A page type is derived from the URL path, and the crawl collapses those paths into
templates over the whole population before it closes — a shape three or more pages
share becomes one template, and a genuine one-off keeps its own path as its type. The
Phase 6 gate site's 551 URLs typed as 196 separate things before that pass existed and
roughly half the sample's seats went to pages that exist once; they now go to
templates. The tail is still there and still costs seats, so the coverage you can
claim is per template, not per page. Check which types were rendered (`pages_query`
with `rendered: true`) before telling an audit that a template was measured. If the
tail crowded out something you needed, `renderMaxPages` / `renderBudgetPct` are
`crawl_start` fields — a finished crawl's cannot be raised, so start a new crawl with
higher ones — or name the pages yourself on this crawl, which is what the section
above is for.

On an explicit pass, `budget`, `suspects`, `sampled` and `truncated` come back
**null**, not zero: no automatic decision was taken, so there was no budget, nothing
was suspected and nothing was cut. `selected` is the length of your list. The same
distinction reaches the audit as `render.coverage`'s `selectionMode`.

## Step 4 — run the rules

`crawl_rules` judges the finished crawl: every rule in the registry over it, findings
and metrics written. It answers the run summary:

```
{pagesScanned, findings, byRule, derived, metrics, byMetric}
```

`findings` is the issue rows this run wrote and `byRule` breaks them down; `metrics`
is the metric rows and `byMetric` breaks those down, naming **every** metric rule that
ran, so a zero there means "this rule removed the crawl's previous answer" and an
absent key means it never ran. `derived` counts what the derivations wrote. There is
**no `elapsedMs`** — time the call yourself if you want to report the duration.

**Keep that summary** for what it alone carries: the per-rule and per-metric
breakdown of what this pass wrote. It is no longer the only proof the rules ran —
`crawl_status`'s `rulesRunAt` is stamped when a pass COMPLETES, and `findingsCount`
counts what it left behind, so the crawl itself now answers the question every empty
listing raises. `issues_list` and `metrics_get` still answer `{"items": []}` both for
a rule that found nothing and for a crawl nobody judged; read the pair before
concluding either. An audit that quotes empty answers without checking the marker is
quoting the absence of a rule run.

It is refused while the crawl is `queued` or `running` — findings about a site still
being fetched change under the reader, and "orphan" is the obvious case: a page is
only orphaned because the page linking to it has not been fetched yet. Running it a
second time re-judges the crawl with the current ruleset, which is what you do after
upgrading the engine rather than re-crawling the site.

### Changing how the crawl is judged

`crawl_config_get` answers the crawl's judgement: `{crawlId, judgement, thresholds,
judgedWith, judgementStale}`. `judgement` is the block, `{}` when nothing is set;
`thresholds` lists all 20 overridable thresholds as `{value, default, min, max,
overridden}`, where `value` is what the NEXT rules run will use; `judgedWith` is what
the last completed run used — `{disabledRules, thresholds, findingCap?}`, its
`thresholds` all 20 at the values that run actually judged with — (`null` if nobody
has judged the crawl); and
`judgementStale` (`{stale, reasons}`) says whether the two differ.

`crawl_config_set` takes `{crawlId, judgement: <patch>}` and answers the same shape.
The patch is a MERGE-PATCH of the stored block: objects merge key by key, and `null`
removes a key — `{"judgement": {"rules": {"title.too-long": null}}}` drops that rule's
override, `{"judgement": {"thresholds": {"SLOW_MS": null}}}` returns `SLOW_MS` to its
default, and `{"judgement": {"rules": null, "thresholds": null}}` clears everything. **The one exception is
`findingCap`: `null` there means uncapped, exactly as at `crawl_start`, never "remove
the key".** Send `200` to go back to the default cap.

When each kind of change takes effect is the thing to get right:

- **Rule overrides act on what is READ, immediately.** Disable a rule and its findings
  leave `issues_list`, `issues_overview`, the CSV views and the exports at once (each
  names it in `disabledRules`); remove the override and they come back at once —
  they were stored all along. A retype or reprioritise changes the served `type` /
  `priority` everywhere at once. None of these needs a run.
- **Thresholds and `findingCap` act at the NEXT `crawl_rules`.** Until you re-run,
  the stored findings and their copy are the old run's, and `crawl_status`'s
  `judgementStale` says so (`reasons` includes `thresholds` or `findingCap`). After
  the run the findings, the copy (a title that names a threshold names the new value)
  and `judgedWith` agree, and nothing is stale.
- **`site.health` is the last run's.** It counted the rules enabled at that run, so
  after a disable or re-enable it stays as it was, and `judgementStale` reads
  `overrides`, until `crawl_rules` runs again.

It is refused, by name and with nothing written, for: a severity override, a metric
rule, a rule id the ruleset does not have, a threshold outside its bounds, a min not
strictly below its max (`TITLE_MIN`/`TITLE_MAX` and the other three pairs, on the
effective values), any key besides `judgement` — and, with a 409, while `crawl_rules`
is running over the crawl: wait for the run to answer, then set it.

**A 409 naming an override on a rule "this ruleset does not define"** — on
`crawl_status`, the listings, the metrics or `crawl_compare` — means the crawl's
stored judgement names a rule a later engine release removed. `crawl_config_set` with
`{"judgement": {"rules": {"<that id>": null}}}` repairs it; it is the one tool that accepts the crawl
in that state.

## Step 5 — when things go wrong

**`status: "failed"`** — the crawl ended badly, and the frontier and pages rows are
whatever it had reached. Read `frontier.failed` and the crawl's pages before deciding
what to do: a crawl that failed at page 4,000 of 5,000 is usually worth **resuming**
(`crawl_resume` — see below), and is worth auditing with the gap stated if the
failure will just recur.

**`status: "paused"`** — the crawl stopped with its frontier intact: an agent's
`crawl_pause` (`pauseReason: "request"`) or the server shutting down
(`pauseReason: "shutdown"`). It is the most resumable state there is: a stop decides
nothing about the work it did not reach, so `crawl_resume` picks up exactly the URLs
and files nobody has asked about yet.

**`status: "cancelled"`** — an agent's `crawl_cancel`. It is **final**:
`crawl_resume` refuses it (409). What was crawled stays judgeable and exportable,
and `neverFetched` says how many URLs were never fetched. A crawl paused or
cancelled while still queued never ran: `crawl_rules` refuses it (409, "never
ran") and a cancelled one's `neverFetched` is null. A cancel is a decision to
stop for good; use `crawl_start` for a fresh crawl.

**Pause or cancel?** Pause when you may want the crawl back: to change pacing
(`crawl_config_set` accepts pacing only while the crawl is queued or paused), to wait out a
block, or to look at the partial data first. Cancel when the crawl is wrong or no
longer wanted. `crawl_pause` and `crawl_cancel` answer 200 when the change happened
now (a `queued` or `paused` crawl) and 202 when it was requested of a `running`
crawl; read `controlRequested` in `crawl_status` until the status changes (about a
second on a small crawl, in every phase since 27d: the host probe, the sitemap walk,
the seeding after it, the page crawl, the 404 probe, the recheck and the resource pass each stop within
about a second; longer on a deep one, because the close runs template inference over
every page before the status flips — the 50k-page gate crawl, paused with 20,000 pages
done, flipped 5.3 s after the request. A crawl that is rendering is already `finished`:
pause and cancel answer 409 there. A cancel during discovery leaves a crawl that never
ran). A cancel outranks a pause. `crawl_delete`
(with `confirm` echoing the crawl id) removes a closed or paused crawl's rows and
files for good.

**`config_validate` before `crawl_start`.** `config_schema` publishes what a crawl
accepts, field by field, with defaults, bounds and when each field can change
(never, only while queued or paused, or always). `config_validate` takes `{config: <the crawl_start
body>}` and answers `{valid, errors, effective}` without starting anything. Run it
first and fix every error it names. Pacing (`maxConcurrency`, `perHostDelayMs`) can be
changed on a paused crawl through `crawl_config_set` with `{crawl, judgement}`; a
resumed crawl is never faster than the spacing it already earned on the host.

**`crawl_resume` — finish a crawl instead of re-running it.** It takes a crawlId and
answers `{crawlId, status, queuePosition}` just as `crawl_start` does, because it IS
the same crawl: same id, same row, same pages, nothing re-fetched. Poll
`crawl_status` from there as usual.

Use it whenever a crawl stopped with work owed — a server restarted mid-crawl, a
worker died, a cancel somebody regrets. It re-reads robots.txt, re-walks the sitemap
and re-runs the host probe first (a crawl resumed hours later honours the rules as
they are NOW), which costs the site a dozen paced requests.

Three things to know before you call it:

- **It keeps `hostSpacingMs`, and applies it crawl-wide.** A site that pushed back is
  not asked to teach the lesson twice. But that field is the widest spacing *any*
  host reached, so the resumed run uses it for every host — a resumed crawl is never
  faster than the one it continues, and can be slower. The 30000ms cap still binds.
- **A capped resource pass gets a fresh budget.** The engine's resource-fetch caps
  are per RUN, not per crawl, so resuming a crawl whose `resources` block reports
  `capped` true grants the whole budget again and may weigh a budget's worth more
  files. Real work on files the crawl saw and never asked about — but a second
  round of requests to somebody's servers, so read `capped` first if that matters.
- **It unjudges the crawl.** `rulesRunAt` goes back to null, because the crawl is
  about to grow and a timestamp over a smaller crawl is the one thing this surface
  must never say. **Re-run `crawl_rules` after the resumed crawl finishes**, before
  reading any findings.
- **A credentialed crawl may need its credentials again.** If the server restarted
  since the crawl started, the resume answers 409 with `code: "CREDENTIALS_REQUIRED"`
  naming the kinds and the header and cookie names; call `crawl_resume` again with
  `requestHeaders` / `httpAuth` / `cookies` of exactly those names. Read the `code`,
  not the sentence. `crawl_render` behaves the same. Never start a fresh crawl
  without them to "get around" it: the gated pages would come back as `blocked` rows.

It is refused when: there is no such crawl; this server is already holding it; the
crawl still holds an unexpired lease (a worker is on it — **wait**, a dead worker's
leases expire on their own); the crawl is terminal with nothing owed, in which case
the refusal names what it counted (pending frontier rows, expired leases, unasked
resource rows) so you can see it looked; the site's host has left the server's
allowlist, which is policy and not a fault; or the crawl's state changed while the
call was checking it, in which case nothing was queued and `crawl_status` says what
it is now. Pages sitting in `frontier.renderPending` are not resumable work — that is
`crawl_render`'s.

**A crawl nobody is working on** — `queued` with `queuePosition: null`, or `running`
with no lease activity long after the server that held it died. Two moves, and
`crawl_resume` is usually the better one: it continues the crawl and keeps the pages
already fetched. `crawl_mark_failed` retires it instead: `queued` or `running`
becomes `failed`, and the pages stay as evidence of a crawl nobody will finish.

`crawl_mark_failed` is refused when:
- the crawl is already terminal — nothing to close;
- THIS server is holding it (running it, or holding it in its queue) — it is alive,
  you are just impatient;
- it still holds an unexpired lease. **Wait.** A dead worker's leases expire on their
  own, and a live crawl between batches holds none for a moment.

This tool is for cleaning up after a crashed server. It is not a cancel button, and
using it on a crawl that is merely slow loses the crawl.

**`crawl_render` answering `{"error": "internal error", "correlationId": …}`** — the
render pass's own refusals (crawl still running, another worker rendering, no
discovery evidence) all come back as sentences naming the reason, so an anonymous
internal error is something else. On a fresh machine it is almost always the missing
browser: run `npx playwright install chromium` and try again. Otherwise the stack is
in the server's log under that correlation id, and that is where to look.

**A fetch failure inside the crawl is not a crawl failure.** Individual URLs that
404, time out or get blocked are recorded as classified rows and become findings —
that is the engine reporting, not the engine breaking. A timeout or a block is
retried up to three times (a block under widening spacing) before it settles as a
row, so one appearing in the results is a URL that failed three times, not once.

## What to hand over

An audit needs these things from this skill, and they should be stated together:

1. the **`crawlId`**;
2. the **`crawl_status`** of the finished crawl — `pagesCrawled`, the frontier
   counts, `renderPassCount`, `blockedPages`, `hostSpacingMs`, `rulesRunAt` and
   `findingsCount`, and whether it stopped at a cap;
3. the **`crawl_render`** `selection` block if a render pass ran — its `mode`
   especially, and on an explicit pass the templates the named pages stood for. That
   is the whole of the coverage claim, and nobody downstream can reconstruct it;
4. the **`crawl_rules`** summary;
5. the crawl's **`crawl_config_get`** `judgement`, if anything was set at
   `crawl_start` or since — the overrides are part of what the findings mean, and
   `judgementStale` should be `false` when you hand over.

Together they say what the evidence covers. The audit's job is to judge that
evidence; its first duty is not to overstate it.

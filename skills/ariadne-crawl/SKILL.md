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
   - `npm run mcp:serve` — MCP on stdio, the preferred surface. Eleven tools,
     no token: an stdio client is the process that started the server.
   - `npm run api:serve` — HTTP on `127.0.0.1:8787` by default, bearer token
     required (`ARIADNE_API_TOKEN`, 16 characters minimum).
   Both need `DATABASE_URL`. Neither invents one.
2. **The target host is on the allowlist.** `ARIADNE_ALLOWED_DOMAINS` is a
   comma-separated list of bare hosts (`example.com`) or subdomain wildcards
   (`*.example.com`). An empty list refuses every crawl and answers every query.
3. **Every legacy host is on it too**, separately, if you plan to pass
   `legacyHosts` — the probe fetches those before it has read anyone's robots.txt.
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
| `crawl_mark_failed` | `POST /crawls/:id/fail` |
| `issues_list` | `GET /crawls/:id/issues` |
| `issue_urls` | `GET /crawls/:id/issues/:ruleId/urls` |
| `metrics_get` | `GET /crawls/:id/metrics` |
| `pages_query` | `GET /crawls/:id/pages` |
| `export_crawl` | `GET /crawls/:id/export` |

Over HTTP every request carries `Authorization: Bearer $ARIADNE_API_TOKEN`. Filters
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
- **`maxDepth`** — leave unset unless you mean to truncate. A depth cap truncates the
  depth distribution the audit reports.
- **`probeHosts`** — on by default, and the only evidence behind the host checks
  (apex vs www, http vs https, legacy hosts). Turning it off makes those checks
  unanswerable rather than clean.
- **`legacyHosts`** — hosts the site used to live on. Each must be allowlisted in its
  own right; they are different sites by every definition the engine has.
- **`renderBudgetPct` / `renderMaxPages` / `renderSamplePerType`** — the render
  pass's sample, stored on the crawl row now and read by the render pass later. Set
  them here if the default sample would not cover the page types you care about.

**`userAgent`**, **`perHostDelayMs`** and **`maxConcurrency`** are the politeness
settings, not tuning knobs for speed. The user agent must stay identifiable, and
robots.txt's own `crawl-delay` wins over `perHostDelayMs` when it is longer. The only
direction you may ever move the other two is **slower**, and the platform table below
is when to do it.

### Pacing by platform

Most e-commerce sites sit behind a WAF running a token bucket: it is not counting your
requests, it is counting how bunched they are. Defaults are for an ordinary origin.

| The site is… | How to tell | Start with |
|---|---|---|
| Shopify, or anything Cloudflare-fronted | `cdn.shopify.com` assets, `x-shopid`, `myshopify.com` redirects; `cf-ray` / `server: cloudflare` on any response | `maxConcurrency: 2`, `perHostDelayMs: 1000` |
| Same, and `blockedPages` is climbing mid-crawl | see Step 2 | stop, re-crawl at `maxConcurrency: 1`, `perHostDelayMs: 2000` |
| Anything else, no evidence of a WAF | — | leave the defaults |

These are the settings a Screaming Frog crawl of a Shopify store is run at (2 threads,
1 URL/second), for the same reason. A 2,000-page site at `2 / 1000` takes around
twenty minutes. That is the correct amount of time.

Do not raise them to make a crawl finish sooner. If it is too slow to be practical,
crawl fewer pages (`maxPages`), not faster.

There is no `allowPrivate` on this surface at any value. The schema refuses it as an
unrecognised field and the service refuses it again by name. A loopback or RFC1918
target is not something this skill can crawl.

## Step 2 — poll it

`crawl_status` is the polling tool:

```
{crawlId, siteUrl, status, startedAt, finishedAt, pagesCrawled, pagesTotal,
 renderPassCount, rulesetVersion,
 frontier: {pending, leased, done, failed, renderPending},
 queuePosition, liveLeases, blockedPages}
```

What the fields mean when you are waiting:

- **`status`** — `queued`, `running`, `finished`, `cancelled`, `failed`. The last
  three are terminal.
- **`frontier.pending` + `frontier.leased`** — URLs still to fetch and URLs in
  flight. This is the progress bar: `pending` falling while `done` rises is a healthy
  crawl, however slow.
- **`liveLeases`** — unexpired worker leases. A live crawl BETWEEN BATCHES
  momentarily holds none, which is exactly the window an impatient caller looks in.
- **`queuePosition`** — a number only while THIS server holds the crawl, null
  otherwise. `status: "queued"` with `queuePosition: null` is the one genuinely broken
  state: the server that accepted the crawl is gone and nobody will run it. Re-submit
  it, or retire it with `crawl_mark_failed`.
- **`rulesetVersion`** — stamped when the crawl was ACCEPTED. It does not tell you
  whether the rules have run.
- **`blockedPages`** — pages a WAF or rate limiter answered instead of the site
  (401, 403, 429, or a challenge page). Watch it across polls: the number matters far
  less than whether it is still rising. See the reaction loop below.

Poll every 15-30 seconds early and back off to a minute on a long crawl; there is
nothing to gain from tighter polling, since the crawl's pace is set by politeness
rather than by anything you can ask for.

### When `blockedPages` climbs

The engine protects itself before you get a chance to. A blocked answer **doubles
that host's spacing** (1s → 2s → 4s → 8s, up to 30s) and the ratchet never winds back
inside a crawl; a `Retry-After` header is honoured as a floor under the next request;
and each blocked URL is **retried up to three times** under the widened spacing, so a
page that was refused during a burst is usually served once the crawl has slowed down.
A crawl visibly getting slower after some early blocks is that working, not a fault.

So read the trend, not the total:

- **A handful of blocks that stops rising** — the back-off found the site's rate.
  Leave it alone. A slow crawl is the engine being polite.
- **Still climbing after several polls** — the escalation has not found a rate the
  site will accept. Let this crawl finish (its rows are still evidence), then re-crawl
  at `maxConcurrency: 1`, `perHostDelayMs: 2000`.
- **Climbing again on that slower re-crawl** — stop. The site is refusing us, not
  merely throttling us, and the next step is a conversation with whoever owns it about
  allowlisting our user agent. **Do not push harder, do not change the user agent to
  look like a browser, and do not crawl from somewhere else.** Being throttled by a
  WAF is our problem to solve honestly; working around one is not something this skill
  does.

A page that is still blocked after its three attempts also counts in
`frontier.failed`, for the same reason a spent timeout does: its own outbound links
were never read, and findings that depend on the link graph are qualified accordingly.

Blocked pages are recorded, not lost: `pages_query` returns each one with
`fetchClass: "blocked"`, its status code, and a `fetchReason` saying how many attempts
it took and what the spacing had reached when the engine gave up. That reason is what
to quote when you report a crawl as incomplete.

**A slow crawl is the engine being polite. Do not restart it.** The pacing is a
per-host delay plus whatever `crawl-delay` the site's robots.txt asks for, and a
restart neither speeds that up nor preserves what was already fetched — it starts a
second crawl over a site that is already being crawled. If the elapsed time is
genuinely wrong (nothing moving in the frontier for many minutes, `liveLeases` at
zero across several polls), that is a stuck worker, and the answer is Step 5.

## Step 3 — render (before the rules, or not at all)

`crawl_render` re-fetches a budgeted sample of the crawl's pages in a real browser
and stores what JavaScript added. It answers counts:

```
{rendered, failures, unrendered,
 elapsedMs, selection: {selected, budget, suspects, sampled, truncated}}
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
`crawl-delay` to honour). It paces itself with the crawl's own delay and user agent —
it is a second visit, not a ruder one.

Read the `selection` block rather than the `rendered` count alone: `budget` is what
the crawl's render fields allowed, `suspects` and `sampled` are how the pages were
chosen, and `truncated: true` means the budget cut the selection. A render pass that
covered 20 of 4,000 pages is evidence about 20 pages.

## Step 4 — run the rules

`crawl_rules` judges the finished crawl: every rule in the registry over it, findings
and metrics written. It answers the run summary:

```
{pagesScanned, findings, byRule, byMetric, elapsedMs}
```

**Keep that summary.** It is the only proof the rules ran: `issues_list` and
`metrics_get` answer `{"items": []}` both for a rule that found nothing and for a
crawl nobody judged, and nothing on `crawl_status` distinguishes the two. An audit
that quotes empty answers without it is quoting the absence of a rule run.

It is refused while the crawl is `queued` or `running` — findings about a site still
being fetched change under the reader, and "orphan" is the obvious case: a page is
only orphaned because the page linking to it has not been fetched yet. Running it a
second time re-judges the crawl with the current ruleset, which is what you do after
upgrading the engine rather than re-crawling the site.

## Step 5 — when things go wrong

**`status: "failed"`** — the crawl ended badly, and the frontier and pages rows are
whatever it had reached. It is a terminal state; nothing resumes it from this
surface. Read `frontier.failed` and the crawl's pages before deciding whether to
re-crawl: a crawl that failed at page 4,000 of 5,000 may still be worth auditing with
the gap stated.

**`status: "cancelled"`** — the server was shut down while this crawl was running,
and it recorded itself on the way out rather than being killed. Same disposition as
`failed`: no resume tool on this surface, so start a new crawl when you need one.

**A crawl nobody is working on** — `queued` with `queuePosition: null`, or `running`
with no lease activity long after the server that held it died. `crawl_mark_failed`
closes it: `queued` or `running` becomes `failed`.

It is refused when:
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

An audit needs three things from this skill, and they should be stated together:

1. the **`crawlId`**;
2. the **`crawl_status`** of the finished crawl — `pagesCrawled`, the frontier
   counts, `renderPassCount`, `blockedPages`, and whether it stopped at a cap;
3. the **`crawl_rules`** summary.

Together they say what the evidence covers. The audit's job is to judge that
evidence; its first duty is not to overstate it.

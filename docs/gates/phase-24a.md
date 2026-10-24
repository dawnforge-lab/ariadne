# Phase 24a gate: throttling and platforms

Date: 2026-10-23. Spec: `docs/superpowers/specs/2026-10-23-throttling-platforms-design.md`
(owner-approved 2026-10-23, all three decisions yes). Plan:
`docs/superpowers/plans/2026-10-23-phase-24a-throttling-platforms.md`. Branch
`worktree-phase-24a`, gate run on 90112a5.

**Verdict: clauses 1–5 pass; clause 6 (no lingering 429) FAILS.** The single
AriadneBot request to `/` 61 s after the run was answered `429` with
`Retry-After: 60`. That failure is recorded here as the gate requires, and was not retried.
§6 sets out what the evidence does and does not show about its cause.

**Owner ruling, 2026-10-24 ("Ok, I agree"):**

1. The Shopify floor stays at 1000 ms with the bounded recovery. Two absorbed 429s per 600
   pages, with every throttled URL retried and none lost, is Shopify braking and the crawler
   handling it.
2. Clause 6 as written cannot separate a penalty we left from the store's baseline treatment
   of a first AriadneBot request, because the pre-run control was also 429'd. It is replaced
   for future gates by a before-and-after probe pair, each probe retried once after its own
   `Retry-After`. Clause 6 is therefore set aside as inconclusive rather than failed, and the
   phase closes on clauses 1–5.

## Gate clauses (spec §5)

| # | clause | result | where |
|---|---|---|---|
| 1 | platform detected as `shopify`, concurrency 1 / 1 s applied and recorded | **pass** | §1 |
| 2 | exactly 600 pages | **pass** (600, `frontier_capped` true) | §2 |
| 3 | throttle record shown: 429s, escalations, recoveries | **pass** (2 / 2 / 1, locked) | §3 |
| 4 | wall time vs `crawl_eda91d81`'s 20 m 44 s | **pass**: 15 m 36 s crawl | §4 |
| 5 | render pass paced, cache shared, same-origin request count vs the old design | **pass**: 21 renders, 0 errors, 60 paced / 280 from cache / 0 unpaced | §5 |
| 6 | one AriadneBot request to `/` 60 s after the run returns 200 | **FAIL: 429** (`Retry-After: 60`) | §6 |
| — | `RECOVERY_STREAK` kept or retuned, with the reason | **kept at 50** | §7 |
| — | memory: peak RSS | 229,288 kB (223.9 MB) | §8 |
| — | Review Focus 1–5, each cited to the test that pins it | | §9 |
| — | full suite, tsc, tree; counts | 86 files / 2,443 tests green, tsc clean | §10 |

## The run

One Node process, the way the engine runs. It calls `ApiService.startCrawl`, polls
`getCrawl`, then calls `ApiService.renderCrawl` and `ApiService.runRulesForCrawl`. RSS was
sampled every 250 ms, and the whole process was wrapped in `/usr/bin/time -v`. The script
is `/tmp/claude-1000/-home-eugen-dev-Workflows-ariadne/002c1ab6-3d41-46fc-8006-c1afc3e7c692/scratchpad/gate24a/crawl.mts`
and the log is `crawl.log` beside it. Neither is in the tree.

Request: `{siteUrl: "https://lavishalice.com/", maxPages: 600, fetchResources: false}`.
Everything else is an API default, so the stored config is `maxConcurrency: 16`,
`perHostDelayMs: 1000`, `maxDepth: 10` and the render budget defaults.
`fetchResources: false` is the one setting that departs from the defaults. It matches
`crawl_eda91d81` and the Phase 23 gate crawl `crawl_6b8a04f5`, so the wall-time
comparison is like for like and the shop is not sent ~resource-count extra requests.

Crawl: **`crawl_6fbf187a-9f17-4d15-9d0b-b4035a5c9234`**, 21:08:24 → 21:24:00 UTC.
The render pass ran until about 21:26:51 and the rules finished at 21:26:59.

## 1. Platform and profile

`crawls.platform` = `shopify`. `crawls.platform_profile_jsonb`:

```json
{"platform": "shopify", "optedOut": false, "appliedAt": "2026-10-23T21:08:29.024Z",
 "applied": {"maxConcurrency": 1, "perHostDelayMs": 1000, "renderConcurrency": 1, "navigationTimeoutMs": 60000}}
```

`appliedAt` is 4.7 s after the crawl started. The host probe named the platform before
the first worker ran, so the configured 16 never reached the site. The pages arrived at
60 per minute while the spacing was 1 s and at 30 per minute at 2 s (§3), which is one
request in flight.

## 2. Pages

`pagesCrawled` 600, `frontier_capped` true, `frontier` `{pending 0, leased 0, done 600,
failed 0}`, `blockedPages` 0, `robotsBlocked` `{recorded 2, dropped 0}`. The pages rows
(602, including the 2 robots-disallowed rows that were never requested) break down as
497 ok/200, 101 redirect/301, 1 client_error/404 and 1 non_html/200. The crawl ended at
the cap with link targets still unfollowed, so the Phase 23 frontier-stall fix held on
this site.

Observation, not a 24a change: `crawl_status.pagesCrawled` read **0 for the whole run**
and 600 only at close, because `crawls.pages_crawled` is written by `closeCrawl`
(loop.ts ~2163). Live progress is in `frontier.done`. Ledgered in §11.

## 3. Throttle record

`crawl_status.throttle` after the crawl, and unchanged after the render pass:

```json
{"lavishalice.com": {"responses429": 2, "retryAfterSeen": 0, "escalations": 2, "recoveries": 1,
 "recoveryLocked": true, "peakSpacingMs": 2000, "finalSpacingMs": 2000}}
```

`hostSpacingMs` 2000. The timeline, from the 15 s `crawl_status` polls and the
`pages.fetched_at` gaps:

| UTC | event | pace |
|---|---|---|
| 21:08:37 | first page (after the sitemap walk's first documents) | 1 s |
| ~21:10:00 | **429 #1**, no `Retry-After` → escalation 1 | 2 s |
| ~21:11:40 | 50 clean answers → **recovery 1** | 1 s |
| ~21:15:00 | **429 #2** → escalation 2, `recoveryLocked` | 2 s, locked |
| 21:15 → 21:24:00 | clean, no further 429 | 2 s |

At 1 s and one request in flight, Shopify gave AriadneBot about 90 requests before the
first 429 and about 200 requests after the recovery before the second. At 2 s it gave
about 9 minutes and no 429. The design held as specified. There was one descent, one
re-trip, then the lock, and no oscillation (the spacing turned from falling to rising
exactly once). Neither 429 cost a page: both were retried under the widened spacing, and
`blockedPages` stayed 0.

## 4. Wall time

| crawl | config | profile | pages | crawl wall time | spacing path |
|---|---|---|---|---|---|
| `crawl_eda91d81` (baseline, 24a-less code) | concurrency 1, 1 s, render off | — | 600 | **20 m 44 s** | 1 → 2 → 4 s, ratchet only |
| `crawl_6fbf187a` (this gate) | concurrency 16 configured, 1 s, render on | shopify: 1 / 1000 ms | 600 | **15 m 36 s** | 1 → 2 → 1 → 2 s, locked |

The gate crawl was 5 m 08 s (25%) faster for the same 600 pages. It never reached the
baseline's 4 s. One recovery bought about 3.3 minutes at 1 s. Crawl, render and rules
together took 18 m 35 s (`time -v` elapsed 18:36.60), still under the baseline's crawl
alone. The comparison is one run each, against a live shop whose bucket state at the
start is not known (§6), so read it as one data point.

## 5. Render pass

`ApiService.renderCrawl` answered:

```json
{"rendered": 21, "failures": 0, "unrendered": 0, "elapsedMs": 158613,
 "requests": {"paced": 60, "fromCache": 280, "unpacedNetwork": 0},
 "unpinnedHosts": [],
 "selection": {"mode": "auto", "selected": 21, "budget": 30, "suspects": 0, "sampled": 21, "truncated": false}}
```

The page rows agree: 21 `rendered`, 0 `render_error`, `render_pass_count` 21. The gate
was seeded from the crawl's record (2000 ms, level 1, locked), so the pass ran at 2 s,
and it reported no 429: the throttle record above is identical before and after the
pass. 60 paced requests at 2 s is 120 s of the 158.6 s.

**Against the previous design.** Before 24a every render opened a fresh context and let
same-origin scripts, stylesheets, xhr and fetch through unpaced. lavishalice's home page
references 36 same-origin theme assets (`/cdn/shop/…`, spec §1), so the old estimate was
about 21 × 36 ≈ 750 unpaced, uncached requests in bursts, plus 21 paced documents. Here
the pass made **340 same-origin requests**. 280 (82%) were answered by the shared HTTP
cache and never reached the site. The 60 that reached the site were all paced at the
earned 2 s spacing. **`unpacedNetwork` was 0**: no mispredicted cache hit, and no
same-origin speculation-rules prefetch fired on this site (the known residual,
§11). `unpinnedHosts` was empty, so the `www.` spelling of the origin was resolved and
pinned too.

## 6. No lingering 429: FAIL

The run ended at 21:26:59 (the last site request was the render pass's, about
21:26:51). At **21:28:00** one request was sent:
`curl -A "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)" https://lavishalice.com/`.

```
HTTP/2 429
content-type: text/plain
content-length: 18
retry-after: 60
server: cloudflare
x-dc: gcp-europe-west1
```

**Clause 6 fails.** It was not retried.

What the evidence says about the cause, and what it does not:

- **Not the render pass at our pace.** The pass's 60 network requests were all paced at
  2 s, there were none unpaced, and the shop answered none of them 429 (the record did
  not move).
- **Not the last minutes of the crawl.** From the second 429 at ~21:15 to the end of the
  render at ~21:26:51, about 11.8 minutes at 2 s, no request was refused.
- **It was there before the run as well.** The pre-flight check at 21:08:13, a single
  AriadneBot request to `/` sent about 9.3 hours after the last crawl of this site
  (`crawl_eda91d81` ended 11:48:57), was also answered **429**. A request a few seconds
  later got 200, and the crawl was started after it. So this storefront 429s a single,
  cold AriadneBot request to `/` at some times when we have not been crawling it for
  hours. A `Retry-After: 60` on `/` 69 s after our last paced request is therefore not
  proof of a lingering penalty from this crawl. It is also not proof against one. The
  gate's question cannot be settled from one request, and the rule forbids asking again
  in a loop.
- What it does show is that Shopify's limiter treats AriadneBot more strictly than a
  steady 1 req/s. Both 24a-era runs on this site tripped at 1 s (the baseline climbed to
  4 s; this one tripped twice at 1 s and held at 2 s). The spec left the UA question open
  (§4, "Whether Shopify treats unknown bots more strictly than SF's UA"), and this run
  is evidence for yes.

The decision this needs (Shopify floor 1000 ms → 2000 ms, or a named-bot allowlist ask
to the store) is in §11 under owner rulings. It is not made here: the 1000 ms floor is
the owner's approved setting (spec §3.1).

## 7. `RECOVERY_STREAK`: kept at 50

The record shows the streak doing what it should. At 50, the host came down from 2 s
after about 100 s of clean answers. It ran at 1 s for about 200 requests (about 3.3
minutes saved against staying at 2 s), tripped once more, and locked. The cost of the
recovery was exactly one extra 429, which the two-strike lock bounds by design. It cost
no page and no `blocked` row.

Retuning would not improve this. A longer streak (say 100 or 200) would only delay the
descent. The re-trip came about 200 requests after the descent, so the bucket's limit
is the request rate, not how soon we came down, and a later descent would hit the same
second strike with less time saved. A shorter streak would come down sooner into the
same bucket. The quantity that protects the site is the lock, not the streak length, and
the lock held. The only re-trip a longer streak could have prevented is the one the
design permits. `RECOVERY_STREAK` stays **50** (`src/crawl/politeness.ts:123`, pinned by
`test/crawl/politeness.test.ts` › "pins RECOVERY_STREAK at 50"). No code change, so
Task 1's tests were not re-run separately. The full suite (§10) includes them.

## 8. Memory

| stage | peak RSS (sampled) |
|---|---|
| crawl + recheck (600 pages) | 223.0 MB |
| render (21 pages, Chromium out of process) | 223.8 MB |
| rules (602 pages scanned, 1,419 findings) | 223.8 MB |
| **process peak** (`time -v` maximum resident set) | **223.9 MB** (229,288 kB) |

That is under the 512 MB contract, and below Phase 23's 299.1 MB at 554 pages. One
reason is that the render pass now reuses one context per worker. Chromium's own
processes are not in the figure. The 50k measurement is still owed (§11).

## 9. Review Focus

| # | focus | pinned by |
|---|---|---|
| 1 | alternating 200/429 (the yellow.com.mt token-bucket shape): the host recovers at most once, then locks, and the spacing never oscillates more than once | `test/crawl/politeness.test.ts` › "HostGate recovery from back-off" › "alternating 200/429 never recovers more than once (the token-bucket shape)"; with "an escalation after a recovery locks recovery for the rest of the crawl", "descends one level per RECOVERY_STREAK, all the way to base, then locks on the next escalation", "never recovers below the host's base". **Shown live in §3**: one recovery, one re-trip, locked. |
| 2 | resuming a pre-24a crawl whose `host_spacing_jsonb` is a plain `{host: ms}` map loads without error, and the earned spacing still binds | `test/crawl/politeness.test.ts` › "HostGate snapshot and restore" › "accepts the pre-24a {host: ms} map, and the earned spacing still binds" and "throws on anything that is neither shape"; at loop level `test/crawl/loop.test.ts` › "resumes each host at its own earned spacing from the per-host map" (seeded `{host: 250}`) and "re-persists a non-widest host's escalation mid-crawl, not only at close" (seeded with the pre-24a shape). The 24a shape resumes with its state: "earns two real hosts' distinct spacings and resumes each at its own". |
| 3 | a Shopify store whose CDN strips the Shopify headers is not detected (`platform` null, configured settings apply, visibly), and a non-Shopify site is never profiled | `test/crawl/loop.test.ts` › "platform profile" › "does not profile a storefront whose CDN strips the Shopify headers" and "never profiles a site that is not Shopify"; detection itself in `test/crawl/platform.test.ts` › "detectPlatform" › "names nothing when neither signal is there" |
| 4 | render isolation: a cookie or localStorage value set while rendering page N is absent on page N+1, while the HTTP cache still serves page N's assets | `test/crawl/renderer.test.ts` › "PageRenderer under the crawl's pacing (Phase 24a)" › "clears cookies and storage between pages and keeps the HTTP cache" (real Chromium). **Shown live in §5**: 280 cache hits over 21 renders. |
| 5 | paced renders: same-origin requests never start closer together than the host spacing; a page that cannot finish within the budget is a classified `render_error` | `test/crawl/renderer.test.ts` › "starts every same-origin request at least one spacing after the last", "paces a redirect hop like any other request", "re-enters the host at the spacing the crawl earned, from its first render", "classifies a page that cannot finish inside its budget at the site's pace"; pass level "paces from the per-host state the crawl earned, at its level, not doubled again". **Shown live in §5**: 60 paced, 0 unpaced. |

## 10. Verification

| | |
|---|---|
| `npm test` | **86 files / 2,443 tests, 0 failures** (222.3 s; run 2026-10-23 on 90112a5 plus this commit's docs, after the gate run) |
| `npx tsc --noEmit` | clean |
| `git status` | clean after this commit; the gate's scripts and logs live outside the tree |
| migrations | **0000–0024** (25 files; 0024 = `crawls.platform`, `crawls.platform_profile_jsonb`) |
| ruleset | **0.18.0**, unchanged by 24a |
| rules | **114**, unchanged: 33 page / 67 query / 14 metric; 33 critical / 31 warning / 50 info; 13 markers |
| `RECOVERY_STREAK` | 50, unchanged |

Docs and skills closed by this commit:

- `skills/ariadne-crawl/SKILL.md`: "The ratchet never winds back inside a crawl" was
  false since Task 1. It is replaced by the bounded recovery, the two-strike lock and how
  to read `recoveries` / `recoveryLocked`.
- `docs/talos-surface.md`: the status header now reads Phase 24a, migrations 0000–0024.
  The throttle paragraph states the recovery rule, and §8's "for the life of the crawl"
  is replaced by the recovery, the lock, the profile and render pacing.
- `docs/talos-integration.md`: the obligation 4 paragraph gains the recovery, the
  throttle record, the Shopify profile and render pacing.

## 11. Ledger for what comes after 24a

### Owner rulings needed

Both questions below were answered on 2026-10-24: keep 1000 ms, and use a before-and-after
probe pair for future gates (see the verdict at the top).

- **Clause 6 failed: is the Shopify floor 1000 ms right for AriadneBot?** Both runs on
  this site tripped at 1 s, and a cold single AriadneBot request to `/` was 429'd before
  the run as well as after it (§6). The options are to raise the Shopify profile's
  `perHostDelayMs` floor to 2000 ms (the floor this run settled at, and the crawl skill's
  own Shopify row), or to keep 1000 ms (the owner's SF setting) and ask the store to
  allowlist AriadneBot, or both. The cost of 2000 ms is about 20 minutes for 600 pages
  instead of about 16. Not changed here: the 1000 ms floor is an owner-approved spec value.
- **Whether a lingering-429 check can be one request.** Given the pre-run 429, a single
  probe cannot tell a lingering penalty from the store's baseline treatment of the UA.
  A defensible gate needs a control, either a pre-run probe recorded as part of the gate
  or a second UA, and that is an owner call because it is extra traffic to a client site.

### Observations from this gate (not 24a defects)

- `crawl_status.pagesCrawled` is 0 for the whole of a running crawl and is set only at
  close (`closeCrawl`, loop.ts ~2163). `frontier.done` is the live count. A driving agent
  that polls `pagesCrawled` sees no progress for 15 minutes. This predates 24a. Fix it,
  or document `frontier.done` as the progress field in the skill.
- No same-origin speculation-rules prefetch fired on lavishalice (`unpacedNetwork` 0),
  so the known residual was not exercised live.

### Rulings made this phase (binding; full text in the SDD ledger)

- T2 demo label (orchestrator copy): "throttled by site", value
  "<host>: <responses429> × 429, slowed <escalations>×, recovered <recoveries>×<, recovery
  locked>, spacing <final> s (peak <peak> s)".
- T3 owns the profile values reaching run-render.ts (renderConcurrency,
  navigationTimeoutMs). T4 owns pacing, cache and isolation inside renderer.ts.
- T1 recovery is one level per `RECOVERY_STREAK` while unlocked (a multi-level descent),
  and any escalation after a recovery locks. lavishalice escalated 1→2→4 s, and a single
  step would have left it at 2 s.
- A clean response excludes `blocked` 401/403/cf-mitigated, which is stricter than the
  spec's "4xx other than 429". The spec's §3.2 was amended.
- T3 I3 was fixed in-phase: sitemap documents honour max(perHostDelayMs, robots
  crawl-delay, profile floor) for every crawl.
- T3 minors 4 (probe gate raised on a Shopify hit) and 5 (render delay floored by
  `applied.perHostDelayMs`) were taken into the round; 6 (render lease) went to T4.
- T4 keeps the cache prediction, on condition that I1 (never predict after a miss) and M8
  (predict only when `Vary` is absent or Accept-Encoding) land. The gate asserts
  unpacedNetwork ≈ 0, and it was 0 (§5).
- T4: all minors 4–8 were taken into the fix round. Both security findings were
  addressed with fail-closed interception.
- T4 round 2 pins Chromium's resolver to the url-policy-approved IP
  (`--host-resolver-rules`).
- T4 round 3 builds the fence bypass and the DNS pin from every spelling `isSameOrigin`
  admits (www/apex, http/https on default ports). There is no narrowing of `isSameOrigin`.
- A launch-time `UrlPolicyError` maps to a classified 409 on both transports, and the
  render-pending rows are left as an existing launch failure leaves them.
- The T4 spacing test tolerance is a total span within 20 ms and each gap within 30 ms.
- T4 round 4 redacts raw resolver and transport text from the 409 and `unpinnedHosts`,
  keeps the resolved IP and range wording, and rethrows a non-`UrlPolicyError` in the
  other-spelling catch.
- T4 accepts the 409's "; detail logged under <uuid>" phrase.

### Deferred minors (from the task reviews)

- T1: the `maxSpacingMsByHost` and `earnedSpacingByHost` constructor options are now
  test-only. `restore` does not cross-check the stored `spacingMs` against base×2^level.
  One loop.ts docblock line is overlong.
- T2: the finished-crawl summary grid has no throttle cell. A pre-24a empty `{}` map is
  served as `{}`, an inherent ambiguity. (The talos-surface status header is closed by
  this gate.)
- T3: with `probeHosts: false`, a Shopify seed slower than one configured spacing lets up
  to WINDOW_INITIAL−1 siblings out at the old pace. This is inherent and documented.
- T3: the sitemap walk is now max(perHostDelayMs, Crawl-delay) for every crawl, about
  5 minutes of discovery for 300 shards at 1 s. This is intended and documented.
- T4: after a launch failure, rows stay `render_pending` and `render.coverage` reads
  "ran" with no evidence. This predates 24a and is now reachable via the 409; it goes to
  Phase 24b.
- T4: the same-origin speculation-rules prefetch cannot be disabled in this Chromium.
  It is counted in `unpacedNetwork` and reported to the gate. The Reporting API, NEL and
  worker WebSocket are untested. REQUEST_GONE and target-closed are matched by message
  text. The `unpinnedHosts` reason has no correlation id (it is logged under the crawl id).
- From earlier phases, still owed: the 50k memory measurement (yellow.com.mt allowlist).

### Carried from the plan's outline

- **Phase 24b, graph and international depth:** hreflang from the HTTP `Link` header and
  sitemap `xhtml:link`; link-graph quality; uncrawlable links; rendered links stored;
  sitemap protocol limits; canonical hygiene; pagination integrity.
- **Phase 25, signals and calibration:** the priority axis; external links; mixed
  content; pixel widths; the black-box calibration; mobile render; the 50k memory
  measurement.

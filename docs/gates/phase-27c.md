# Phase 27c gate: crawl scope and requests

Date: 2026-11-09. Spec: `docs/superpowers/specs/2026-11-08-phase-27-agent-control-plane-design.md`
(the "27c — Crawl scope and requests" section, "Gate 27c" and "Surface"). Plan:
`docs/superpowers/plans/2026-11-09-phase-27c-scope-and-requests.md`. Branch
`worktree-phase-27c`, built on `c8315e5` (PR #26's merge). The code under test is
`2a7e161` (Task 11's commit, the last code change of the build) plus the gate script's
`--exclude` flag (`ffcfaad`); the docs, skills and tool descriptions are `7f1c4dc`. The
full suite ran on `7f1c4dc` (the working tree differed only by this document and the 27b gate doc) (§1).

**Verdict: BLOCKED on clause 5's 5% bound. Clauses 1 to 4 pass; clause 5 passes the
512 MB contract and the excluded census but its peak, 312.4 MB, is over the "within 5% of
27b" ceiling of 290.2 MB; clause 6 waits for the owner.** No limit was raised (hard rule
6). §5 says why the 27b figure may not be a like-for-like baseline, and what would settle
it; that decision is the owner's, not this gate's.

Ruleset 0.24.0, 189 rules (72 page / 103 query / 14 metric), one new rule
(`crawl.list-mode`, a NOT MEASURED marker); `EXTRACTION_VERSION` unchanged. Migration 0036
(`list_urls`, `frontier.redirect_hops`, `crawls.excluded_dropped`,
`crawls.scope_changed_at`). 27 MCP tools / 27 HTTP routes, unchanged; 9 command tools.

## Gate clauses

| # | clause | result | where |
|---|---|---|---|
| 1 | full suite and the harness green, 0 skipped; `tsc` clean | **pass**: 152 files / 4,042 tests, 0 failed, 0 skipped; `tsc` clean | §1 |
| 2 | the fixture gains a Basic-auth area, a cookie-gated page, a header-gated page and a redirect chain over 10 hops, each with positive and negative tests, including credentials not crossing to another host and not following a redirect off the site family | **pass** | §2 |
| 3 | the secret scan passes, and a restart test shows `CREDENTIALS_REQUIRED` rather than 401 rows | **pass** | §3 |
| 4 | a list crawl of the fixture: every listed URL classified, the spider-only rules marked by `crawl.list-mode`, no rule firing because of the missing graph | **pass** | §4 |
| 5 | the 50k gate re-run with an `exclude` pattern: at most 512 MB and within 5% of 27b's 276.4 MB (at most 290.2 MB) | **512 MB: pass** (312.4 MB). **5% bound: FAIL** (312.4 MB against 290.2 MB; +13.0% over 276.4). Census: **pass** (11,111 `excluded` rows, all naming the pattern, `excluded_dropped` 0, 0 fetched rows the pattern refuses, 38,889 pages fetched) | §5 |
| 6 | a small live list crawl of lavishalice (about 50 URLs), findings reviewed for false positives | **pending — owner OK required**; not run | §6 |

## 1. Clause 1: suite and types

| | |
|---|---|
| `npm test` (`DATABASE_URL` set) | **152 files / 4,042 tests, 0 failed, 0 skipped** (390.9 s), on `7f1c4dc`. The known `renderer.test.ts` flake did not appear |
| `npx tsc --noEmit` | clean |
| baseline at the branch point (`c8315e5`) | 142 files / 3,874 tests |
| phase delta | +10 files, +168 tests |
| MCP tools / HTTP routes | 27 / 27, unchanged; command tools 9 |
| skills and surface guard | `npx vitest run test/skills`: 25 of 25, including the citations of `docs/talos-surface.md` |

The harness (`test/fixtures/harness.test.ts`) runs inside `npm test` and drives the whole
fixture site, render pass included. The new fixture areas have their own end-to-end file,
`test/fixtures/scope-and-requests.test.ts` (§2 to §4), which also runs inside `npm test`.

## 2. Clause 2: the fixture's gated areas and the redirect chain

`test/fixtures/app.ts` gains a Basic-auth area (`/auth/*`, 401 without the right
`Authorization`), `/cookie-gated` (403 without the session cookie), `/header-gated` (403
without `x-fixture-key`), `/auth/to-legacy` (a 302 to the fixture's `localhost` name,
outside the site family) and `/chain/0` to `/chain/12`, each a 301 to the next, the last
to `/chain/end` (13 redirects before the 200).

| proof | test |
|---|---|
| positive: a list crawl of the three gated URLs with all three credentials gives three `ok` 200 rows | `test/fixtures/scope-and-requests.test.ts` "a list crawl of the three gated URLs with credentials gives three ok rows" |
| negative: with no credentials, and with each one left out in turn, exactly the gate whose credential is missing is a `blocked` row with the site's 401 or 403, and the other two are `ok` | "without a gate's credential that URL is a blocked 401/403 row and the other two are ok" |
| no crossing on a redirect: `/auth/to-legacy` is a `redirect` row, nothing on the other name has a page row, the source was requested with credentials, and any request that reached the other host carried no `authorization`, cookie or custom header | "/auth/to-legacy redirects to localhost: the target is not fetched with authorization, cookie or the custom header" |
| no crossing on the wire, every request kind: all three are sent on the page fetch, robots.txt, the sitemap, the 5xx recheck, the 404 probe and a same-host resource, and none to another host's resource, its robots.txt, a legacy host's probe or a redirect hop | `test/crawl/credentials.test.ts` "sends all three on the page fetch, robots.txt, the sitemap, the recheck, the 404 probe and a same-host resource" and "sends none of them to another host: a resource, its robots.txt, a legacy host's probe, a redirect hop" |
| the downgrade rule: an https site never sends them over http; an http-only site does on its own http URLs | `test/crawl/credentials.test.ts` "sends nothing over a scheme the site does not use, and nothing when no credentials were given" (unit level, the https half); the http half is every positive fixture crawl above, since the fixture is a plain-http site whose gated pages answer 200 only with the credentials |
| the redirect cap, positive: under the default cap of 10 the chain stops at `/chain/10`, every hop to it a `redirect` row, `/chain/11` not fetched, and `/chain/10`'s reason says `maxRedirectHops is 10` | "a list crawl of /chain/0 stops at /chain/10 and says maxRedirectHops is 10" |
| the redirect cap, negative: with `maxRedirectHops: 20` the same list reaches `/chain/end` (`ok` 200) and no row names the cap | "with maxRedirectHops 20 the same list reaches /chain/end" |

**A 401 or 403 is fetch class `blocked`**, not `client_error`: the fetch layer reads it as
a refusal of this client (a WAF's answer reads the same), so it is retried under the
politeness back-off before its row is final. That is the existing behaviour, and the
negative test asserts it rather than the brief's expectation. The cost is test time
(about 30 s per refused URL, so the four negative crawls run side by side).

**One weak branch, stated.** The crawler never follows a redirect off the site family, so
in the `/auth/to-legacy` test no request reaches the other name at all, and the assertion
"anything that reached the other host carried none of them" runs over an empty set. The
proof that nothing crosses is the row assertions beside it and the unit-level
`credentials.test.ts` case, which drives requests at another host and inspects them.

## 3. Clause 3: the secret scan and the restart

**The secret scan.** `test/fixtures/scope-and-requests.test.ts` "after a crawl with all
three credential kinds and a render pass, no secret is in any stored column or the log":
a list crawl of the gated pages with a Basic password, a cookie value and a custom header
value, then a render pass over the same URLs with the same credentials. It reads every
`text`, `varchar`, `jsonb` and array column of every crawl-scoped table from
`information_schema` (`CRAWL_CHILD_TABLES` plus `crawls`, and asserts the catalog
returned every table), and searches each for each secret: **0 hits**. The render answer
and the server log hold none either. The three gated rows are `ok`, so the credentials
were used, not merely accepted. Beside it, `test/api/scope-start.test.ts` "accepts a
valid set and shows no value in crawl_status, effective, crawl_config_get, the row or the
log" and "refuses an invalid credential set with a body that quotes no secret, on both
transports".

**The restart.** `test/api/credentials-restart.test.ts` "crawl_resume and crawl_render
refuse CREDENTIALS_REQUIRED and write nothing; a resume with them finishes with no 401
row": a crawl of the Basic-auth area started with `httpAuth`, paused with
`crawl_pause` once it had pages, the server closed and a new `ApiService` built on the
same database (its credential map empty). `crawl_resume` and `crawl_render`, over HTTP
and over MCP, answer 409 with `code: "CREDENTIALS_REQUIRED"` naming the crawl and
`httpAuth`, and nothing is written (page and frontier counts unchanged). A resume sent with credentials of another shape is a 400 `VALIDATION`. A
resume with the right credentials finishes, and the crawl holds **no 401 row**. Beside
it: "crawl_render on a finished crawl after a restart: refused without them, renders the
gated page with them", "a maximal credential set is re-supplied over HTTP after a restart
(1 MiB cap); a 64 KiB route still 413s", and the drop on cancel and delete ("cancelling a
queued crawl, cancelling a paused one, deleting one, and a running crawl that ends
cancelled").

## 4. Clause 4: a list crawl of the fixture site

`test/fixtures/scope-and-requests.test.ts` "classifies every URL the hub links, and
crawl.list-mode names what was not measured": every link on the fixture hub (more than 50
distinct URLs, normalised) is listed, and the list crawl runs over the whole fixture
(off-site and asset hosts up, as the harness has them).
- **Every listed URL is classified**: each has a `pages` row (the assertion lists any that
  do not, and the list is empty).
- **The spider-only rules are marked**: after `crawl_rules`, the one `crawl.list-mode`
  finding's `notMeasured` holds every `needsSpider` rule (18) and, since no sitemap was
  read, every `needsSitemaps` rule (13); `partiallyMeasured` holds every `listPartial`
  rule (11).
- **No rule fires because of the missing graph**: no `needsSpider` rule wrote a finding.

The registry side is pinned in `test/rules/list-mode.test.ts` ("never calls a
needsSpider or needsSitemaps rule on a list crawl with no sitemap read, and calls every
listPartial rule", with a spy on each rule) and the loop side in
`test/crawl/list-mode.test.ts` ("fetches every listed URL at depth 0 and follows
redirects but no link", "does not request a siteUrl that is not in the list (robots.txt
it does)", "walks no sitemap without sitemapUrls and says it did not").

## 5. Clause 5: the 50k memory gate with a scope

Command (dedicated database `ariadne_gate27c`, created and migrated with `npm run
db:migrate` before the run, dropped afterwards; the fixture is the loopback
`test/gate/site-server.ts`, nothing external was fetched):

```
DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne_gate27c \
  node --max-old-space-size=512 --import tsx scripts/gate-rules.ts --exclude '*/products/p1*'
```

**The pattern is not the brief's.** The plan's command names `--exclude '*/p/1*'`, which
matches no URL of this fixture: its pages are `/`, `/products/p<n>` and `/blog/<n>`, so
no URL contains `/p/1`. Run as written, the gate would put the matcher on the hot path
and write no `excluded` row, and its census clause would pass by being empty (rule 1).
The script now refuses that (`--exclude` patterns that refuse no fixture URL are a loud
error; the brief's pattern was run at 500 pages to confirm it: "the exclude patterns match
none of the fixture's 500 URLs"). `*/products/p1*` is the nearest pattern that does what
the clause asks: it refuses `/products/p1`, `p10`–`p19`, `p100`–`p199`, `p1000`–`p1999`
and `p10000`–`p19999`, **11,111 of the 50,000 URLs** (22%), every one of them linked from
a fetched page. Ruling 23 records this.

**What the script asserts with `--exclude`** (`ffcfaad`). Before the crawl it counts,
with the crawler's own matcher (`scopeVerdict`), how many fixture URLs the patterns
refuse and how many of those a fetched page links to, by inverting the fixture's link map
(O(1) memory, never a set of URLs, each inverted linker cross-checked against
`linkTargets`). After the crawl: the crawl fetched exactly 50,000 less the refused URLs;
the `excluded` rows equal the linked refused URLs up to the shared budget
(`maxBlockedUrls`, default `maxPages`, less any `disallowed` rows), with the overflow in
`excluded_dropped` (0 when nothing overflowed); every `excluded` row's `fetch_reason` names
one of the patterns; and no fetched row matches them (`scopeRefusesSql`). Everything
else is the 26c/27b gate unchanged: render and rules phases, the rules pass scanning every
page row the crawl wrote (the `excluded` rows included), every metric rule run, peak RSS
at most 512 MB.

Node v22.23.2, one run, on `ffcfaad` (code `2a7e161`), crawl id
`crawl_456257ee-33ed-4fbe-b082-f334efced61a` in `ariadne_gate27c` (the database is kept
for inspection, not dropped).

| | this run (`--exclude '*/products/p1*'`, no pause) |
|---|---|
| exclude census, before the crawl | 11,111 fixture URLs refused, 11,111 linked from a fetched page (91 ms to count) |
| crawl | `finished`, **38,889 pages** (50,000 − 11,111), frontier done 38,889, failed 0; 783.4 s, 49.6 pages/s |
| `excluded` rows | **11,111**, every one `crawl scope: matches exclude pattern '*/products/p1*'` |
| `excluded_dropped` | **0** (budget 55,000, 0 `disallowed` rows: nothing overflowed) |
| fetched rows the pattern refuses | **0** |
| render pass | 7 rendered (budget 500), 0 failures, 8.8 s; browser 1,137.6 MB over 14 processes (not gated) |
| rules pass | 50,000 page rows scanned (the 11,111 `excluded` rows included), 121,082 findings, 38 metric rows, 275.4 s; every metric rule ran |
| phase peaks | crawl **296.5 MB** (at +783 s, the end of the crawl), render 297.8 MB, rules **312.4 MB** (17 s into the rules pass) |
| **peak RSS, every phase** | **312.4 MB** (at +809 s) |
| script verdict | `GATE PASSED` (the script gates 512 MB and the census, not the 5% bound) |

**Clause 5 against its two bounds.** 312.4 MB is 199.6 MB under the 512 MB contract,
and 22.2 MB over the plan's 290.2 MB (27b's 276.4 MB plus 5%). **The 5% bound fails.**

**Why 276.4 MB may be the wrong yardstick, stated and not used to pass the clause.** 27b's
276.4 MB was the gate run with `--pause-at-fraction 0.4`: the crawl ran as two processes'
worth of loop state (20,088 pages, a pause, a resume), and its own first run read 285.2 MB.
The last UNPAUSED runs of this script are 26c's: 297.3 and 297.2 MB (baselines) and 293.7
MB (after), with the peak in the rules pass each time (`docs/gates/phase-26c.md` §3). This
run is unpaused, and its peak is in the rules pass too. Against 26c's 293.7 MB it is +6.4%,
against 26c's 297.3 MB baseline +5.1%: over 5% on either reading, by less. So the run does
not show the scope work to be cheap on memory, and it does not show it to be the cause
either: what changed between 26c and this run is 27a's judgement layer, 27b's lifecycle
work and 27c (189 rules against 188, 11,111 cheap `excluded` rows in the page scan), and
this gate has one run.

**What would settle it** (not done here; the task's instruction on a failed bound is to
stop and report): (1) the same command without `--exclude` on this tree, to separate the
scope's cost from 27a–27c's and from run-to-run spread (26c's two baselines differed by
0.1 MB, 27b's two runs by 8.8 MB); (2) a rules-only re-run over the kept crawl
(`GATE_CRAWL_ID=crawl_456257ee-…`), which isolates the rules-pass peak at 17 s in — the
page-rules phase, whose working set should be one 500-row batch; (3) if either reproduces
above 290 MB, a heap snapshot at that point. Whether 26c's unpaused figure is the right
baseline for an unpaused run is the owner's call.

## 6. Clause 6: the live list crawl of lavishalice

**Pending — owner OK required.** This clause crawls a client site, so it waits for the
owner's explicit go-ahead and was not run. What it will measure, once allowed: a list
crawl of about 50 lavishalice.com URLs (a spread of templates: home, collections,
products, pages, blog posts, and a few known redirects or 404s) at the production
pacing (the Shopify profile: one request in flight, at least 1,000 ms per host), then
`crawl_rules`. Recorded: the crawl id, every listed URL's classification (no URL without
a row), the `crawl.list-mode` evidence (`notMeasured`, `partiallyMeasured`,
`sitemapsRead`), `blockedPages` and the throttle record (no WAF trouble at that pace),
and every finding reviewed against the site for false positives, with special attention
to the `listPartial` rules (a target the list did not fetch must not be reported) and to
`links.broken-internal`'s `listed` rows.

## Rulings

Every ruling made during the build (the SDD ledger), with what it costs if wrong.

1. **The resume re-filter's predicate is `scopeRefusesSql`** (T2), not a hand-built
   `LIKE`: one SQL form of the patterns, pinned to the matcher by T2's parity test. Cost
   if wrong: none.
2. **A list crawl still runs the host probe** (T6): the test asserts no `pages` row for an
   unlisted `siteUrl` and no page fetch of it, while the probe still runs per
   `probeHosts`. The probe is host evidence, not a crawled page. Cost if wrong: a list
   crawl makes up to four probe chains the agent did not list.
3. **`defineRule` refuses `needsSpider`/`needsSitemaps` only on `crawl.list-mode`
   itself**, not on markers in general (`links.orphan-skipped` is flagged): a marker for a
   site-wide condition is itself site-wide. Cost if wrong: none.
4. **The scope matcher is linear** (T2, promoted from a review minor): KMP over the
   literal segments, O(|pattern| + |url|), because admission is the hot path and the spec
   promises an agent-supplied pattern cannot hang the frontier. Cost if wrong: one small
   rewrite of a pure function.
5. **The resume re-filter runs in one transaction in 500-row chunks** (T4), selected by
   `scopeRefusesSql` and written by the same `insertExcluded` the loop uses, so
   `page_type` and the matching-pattern reason come from the TypeScript code; the rest is
   counted by one `DELETE … RETURNING`. The plan's single `INSERT … SELECT` would have left
   `page_type` null and duplicated the reason logic in SQL. Memory stays O(chunk) (rule
   6). Cost if wrong: a resume of a huge frontier takes N/500 round trips.
6. **The re-filter runs both ways** (T4 I2): `excluded` rows the current scope admits go
   back to pending frontier rows (same depth and `discovered_via`, `redirect_hops` 0)
   within the frontier's remaining `maxPages` room; beyond it the row is deleted and
   `frontier_capped` stamped. The spec's "pages already fetched stay as they are" holds:
   an excluded row was never fetched. Cost if wrong: a widened scope fetches URLs the
   agent previously fenced off, which is what widening asks for.
7. **A URL refused only by a per-crawl `maxUrlLength` below 2,500 is an `excluded` row**
   (reason `crawl scope: longer than maxUrlLength (<n> characters; the limit is
   <limit>)`) on the shared budget, so the refusal is a row or a count (rule 7); over
   2,500 it stays url-policy's `too_long`, counted by `url.reference-too-long`. Cost if
   wrong: extra rows on a crawl with a low limit.
8. **A re-admitted `excluded` row robots.txt disallows is re-classed in place as a
   robots-blocked `disallowed` row** (T4 fix 1, budget-neutral), not queued: admission's
   order is scope then robots, so this is the row admission would have written. Cost if
   wrong: none.
9. **A re-admitted URL is not re-run through `isUrlAllowed` before it is queued** (T4 fix
   1): `fetchPage` re-checks the URL policy before any request and writes a `disallowed`
   row on refusal, so rule 5 holds at fetch. Cost if wrong: a policy-refused URL spends a
   frontier slot.
10. **Header values also refuse control characters other than tab and characters above
    U+00FF; cookie values are printable ASCII without `;` or `,`; a header name repeated
    in any case and a cookie name repeated are refused** (T5): undici would reject each at
    the first request and fail the crawl, so refusing at validation is the transparent
    error. Cost if wrong: an exotic but valid header value is refused.
11. **`expect` and `keep-alive` join the refused header names** (T5 minor 3, applied in
    T8): undici refuses both at send time. The list is now 13 names plus `proxy-*`, two
    more than the spec's 11. Cost if wrong: two header names an agent cannot send.
12. **A third registry flag, `listPartial`** (T7 I1), for rules whose answer depends on
    the response of a URL a list crawl reaches only by a link: canonical, hreflang and
    pagination targets, broken and 5xx link targets (11 rules). They still run on a list
    crawl (a target the list did fetch is a true finding, Deviation 7's listed 4xx among
    them), and `crawl.list-mode` names them in `partiallyMeasured`. `redirect.chain` is
    not among them: list mode follows redirects. Cost if wrong: one more evidence key an
    agent must read.
13. **`hreflang.alternates-not-crawled` is flagged `needsSpider`** (T7, beyond the brief):
    on a list crawl every alternate the list did not name would fire it, which is the
    list's doing, not the site's. Cost if wrong: an alternate the list did fetch with a
    broken answer is not reported by this rule on a list crawl (`hreflang.non-indexable-target`
    and `hreflang.inconsistent-return-code` still judge fetched targets).
14. **`sitemapUrls: []` on a list crawl is a `VALIDATION` refusal** (T8), not normalised
    to absent; spider crawls still accept `[]`. "Read sitemaps only if `sitemapUrls` is
    given" makes an empty list on a list crawl a contradiction to fix. Cost if wrong: an
    agent resends without the key.
15. **Listed URLs are checked by the URL policy and `isSameOrigin(url, siteUrl)`, not
    per URL against the exact-host allowlist** (T8). A spider crawl of the same seed
    already fetches the `www` twin (admission and the host probe use `isSameOrigin`), so
    the list's boundary equals the spider's; the allowlist is checked on `siteUrl`. Cost
    if wrong: a listed `www`-twin URL is fetched on an allowlist naming only the apex, as
    a spider crawl of that seed already does.
16. **`LARGE_BODY_BYTES` (1 MiB) also applies to `POST /crawls/:id/resume`, `POST
    /crawls/:id/render` and `PATCH /crawls/:id/config`** (T9): a maximal credential set
    (20 headers, 50 cookies and Basic auth, about 74 KB) is over 64 KiB, and re-supply on
    those routes is the spec's only way back after a restart. The plan's "64 KiB
    elsewhere" yields; the cap is a memory bound and 1 MiB stays bounded. Cost if wrong:
    three more routes accept 1 MiB bodies.
17. **`crawl_config_set` on a queued crawl updates the credential map just after the
    commit** (T9 concern 2): a runner dequeuing in that instant sees the new shape with
    the old values, and the loop refuses loudly (the crawl fails; rule 7 holds). Accepted;
    recorded in `docs/talos-surface.md` §13. Cost if wrong: a rare failed crawl the agent
    re-runs.
18. **Credentials cannot be added on `crawl_resume` or `crawl_render` to a crawl that
    started without any** (T9 concern 4): `VALIDATION`, pointing at `crawl_config_set`
    while paused. A finished credential-less crawl cannot be rendered with new
    credentials: the credential shape is part of the crawl's identity once it ran. Cost if
    wrong: such a site needs a new crawl.
19. **`httpAuth: null` in `crawl_config_set` on a queued or paused crawl removes Basic
    auth** (T9 minor 2), from the map and the stored shape, symmetric with an empty
    `requestHeaders` or `cookies`. The spec is silent; without it Basic auth could never
    be removed. Cost if wrong: one more accepted null.
20. **401 and 403 are fetch class `blocked`** (T10): retried with back-off, then a final
    `blocked` row with the site's status. The fixture tests follow the real behaviour,
    not the brief's expectation of `client_error`. Cost if wrong: none to the crawl; a
    gated URL fetched without its credential costs about 30 s of back-off before its row
    is final.
21. **The 27b Ruling 9 restore change is defensive hardening, not a reproduced bug**
    (T11). A zero-base gate round-trips exactly through snapshot and restore; the state
    the fix handles (base 0 with a stored spacing above 500·2^level) arises only from a
    hand-edited row or one written by an older build. It is kept because it never restores
    faster than the stored spacing and changes no non-zero base. Cost if wrong: none.
22. **`crawl_config_get.crawl` no longer equals `config_validate`'s `effective` for a crawl
    with credentials** (T9; 27b Ruling 1's equality chain gains two named departures):
    `effective` carries `credentialShape` where `crawl` shows the three credential fields
    with every value `"[redacted]"`, and `crawl` adds `scopeChangedAt` on every crawl.
    `docs/talos-surface.md` §4.9 says so. Cost if wrong: none; an agent comparing the two
    must skip three keys.
23. **The 50k scope gate runs `--exclude '*/products/p1*'`, not the plan's `'*/p/1*'`**
    (T12, §5): the plan's pattern matches no fixture URL and would have made the census
    vacuous. Cost if wrong: none to the memory figure (the matcher runs on every
    discovered URL either way); the run exercises 11,111 `excluded` rows instead of none.
24. **The skills guard learns two classes** (T12): `ServiceErrorCode` values, read from the
    union in `src/api/errors.ts`, and `crawl_config_get.crawl`'s reported keys and
    mutability values (`REPORTED_CRAWL_KEYS`, now exported, and `CrawlField.mutable`). The
    alternative was allowlisting `CREDENTIALS_REQUIRED`, `scopeChangedAt` and `whenPaused`
    with a reason, which would not catch a rename. Cost if wrong: none.

## Deviations

From the spec text (owner to see in review):

1. **Migration `0036`, not `0033`.** The spec predates 27a's and 27b's migrations.
2. **The list is stored in a `list_urls` table, not in `config_jsonb`.** 10,000 URLs is up
   to about 1 MiB, and `config_jsonb` is read on every `crawl_config_get`, resume and
   render. `crawl_config_get` and `config_validate`'s `effective` show `listUrlCount`, not
   the URLs. `crawl_delete` removes the table's rows with the rest.
3. **Duplicates in a list are collapsed after normalisation, and counted.** The accepted
   response and `effective` carry `listUrlCount` (distinct) and `listDuplicates`
   (collapsed). Refusing a list for a repeated URL would fail spreadsheets an agent was
   handed; collapsing silently would hide it.
4. **A list crawl's `maxPages` defaults to twice the list** (room for one redirect target
   per listed URL), replacing only the API's 500 default; a request or operator value
   still wins. An explicit `maxPages` below the distinct list size is refused
   (`VALIDATION`), because a listed URL that is never fetched would break "every listed URL
   ends in a classified row".
5. **A listed URL that `exclude`/`include` refuses is a `VALIDATION` error at start**, like
   an excluded seed. Listing and excluding the same URL is a contradiction to fix, not a
   row to write.
6. **A second registry flag, `needsSitemaps`.** A list crawl reads no sitemap unless
   `sitemapUrls` is given, and without a sitemap read the sitemap rules would be silent
   about sitemaps the site declares, which reads "clean" (rule 1). Rules flagged
   `needsSitemaps` skip on a list crawl that read no sitemap, and `crawl.list-mode` names
   them too. With `sitemapUrls` given, discovery walks the declared and the supplied
   sitemaps exactly as a spider crawl does, and only the entries' enqueue is skipped.
7. **On a list crawl, `links.broken-internal` also reports a listed 4xx URL with no
   inlinks** (`inlinks: 0`, new optional column `listed`). 4xx has no page rule, so a
   listed 404 would otherwise be reported by nothing. 5xx already has
   `http.server-error`.
8. **Excluded sitemap entries are not written as rows** (the robots-blocked precedent:
   they are already in `sitemap_urls`, and writing them would spend the budget before the
   first link). Rules that report a sitemap, pagination or hreflang URL as "not crawled"
   leave out URLs the crawl's CURRENT scope refuses, read through the SQL form of the
   patterns (`scopeRefusesSql`): the agent fenced them off, so "not crawled" is our
   decision, not the site's defect.
9. **Credentials stay in the API process's map until the crawl is deleted or cancelled**,
   not until it finishes: `crawl_render` on a finished crawl needs them. After a restart
   the map is empty and `CREDENTIALS_REQUIRED` applies.
10. **Every `ServiceError` body gains `code`** (`{error, code}` over HTTP, the same two keys
    in MCP's JSON error). Additive. It is how an agent tells `CREDENTIALS_REQUIRED` from
    any other 409 without parsing a sentence.
11. **`maxUrlLength` is `never`.** Changing it mid-crawl would need the same re-filter the
    scope lists get, for a field nobody changes after start.
12. **The redirect cap is per chain, counted on the frontier row**
    (`frontier.redirect_hops`). A redirect target inherits its source's count plus one.
    The redirect row whose target would exceed the cap carries the reason, and the target
    is not queued. A target already in the frontier keeps its own count.

Added during the build and by the gate run:

13. **The 1 MiB body cap covers five routes, not two** (Ruling 16): the spec raises it
    for `POST /crawls` and `POST /config/validate` only.
14. **13 refused header names plus `proxy-*`, not 11** (Ruling 11): `expect` and
    `keep-alive`.
15. **The 50k scope gate's pattern is `*/products/p1*`** (Ruling 23, §5).
16. **The live lavishalice list crawl (clause 6) is not part of this gate run**: it waits
    for the owner's OK (§6).

## Open at this gate

Flagged "fix in final wave" in the ledger and not closed by Task 12 (the controller's
final review owns them):
- T4 C: the robots re-class `UPDATE` on resume writes `robotsBlockedReason(line)` without
  `storableCap`, so a NUL in the matching `Disallow` line would fail every resume.
- T4 B: `CrawlConfig.maxUrlLength`'s docblock claims redirect targets become `excluded`
  rows; `fetchPage` refuses them first and records `redirect target refused: too_long` on
  the redirect row (rule 7 holds; the docblock is wrong).
- T4 A: the forward re-file measures the budget before the backward pass frees room, so a
  narrow-then-widen edit can overstate `excluded_dropped`.
- T5 2, 4, 5: the renderer's merged headers let a credential header override a browser
  header of the same name; repeated browser headers passed back unchanged may fail a
  credentialed render; `credentialShapeError` checks types only. (T5 1, the override
  shape smaller than the row's, was closed in `dcd4a0a`.)
- T6: rows read from `list_urls` are not checked against `listUrlCount`, so an empty or
  short table ends "every listed URL was refused" instead of a loud defect.
- T9 concern 2 (Ruling 17): the queued-crawl credential race.
- T10: the vacuous no-crossing loop in `scope-and-requests.test.ts` (§2).

## Carried to Phase 28

- **Credentials live in one process's memory.** Phase 28's multiple workers will need
  each worker to be handed the credentials of the crawl it runs; today a second process
  answers `CREDENTIALS_REQUIRED` exactly as after a restart.
- **`crawl_overview`'s `urls` section does not count `excluded` rows** or
  `excludedDropped` (`docs/talos-surface.md` §4.3b, §13).
- **URLs counted in `excluded_dropped` under an older scope cannot be re-admitted by
  widening it**: they are counts, not rows.
- Subdomain crawling with its own cap (owner, 2026-11-08): backlog.

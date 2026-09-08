# Phase 15 gate — the demo web surface

Phase 14 closed the engine-side ledger and said the next work would be new
direction, not closure. This is that work: **a local web page where the owner
types any website's URL, runs an audit, watches it run, and reads the results**
— the owner's chosen direction on 2026-09-03, and deliberately "a real use case
test and stress", not a fixture demo.

It is a **thin** phase by construction. The JSON HTTP API already covered the
whole flow (accept → status → render → rules → issues → issue URLs → metrics),
so the demo adds a page and a proxy in front of the surface that already exists
and changes the engine in exactly one place: a code-only allowlist posture,
`allowAnyPublicHost`, without which "type any URL" is impossible and with which
nothing a Talos deployment runs behaves differently.

**The production surface is untouched.** `src/api/http.ts`, `src/api/mcp.ts`,
`src/api/serve.ts` and `src/api/mcp-serve.ts` are byte-identical to base
`4de179d` (`git diff --stat 4de179d..HEAD --` over those four files is empty);
`package.json` gained one script line and nothing else. 16 MCP tools / 16 HTTP
routes, unchanged.

The spec's gate clauses, and where each is answered:

| | The spec asked | Answered |
|---|---|---|
| 1 | a real run, owner present: `npm run demo`, a real site, live panel, results — site, pages/duration, blocked + spacing, severity-band counts | §4 — **recorded 2026-09-08**: lavishalice.com, 50 pages in 56 s, 0 blocked, spacing 1000 ms, 1 / 2 / 8 rules per band; the machinery it exercises is pinned in §1–§3 |
| 2 | at least one deliberately-refused input: a private IP typed into the page, refused with url-policy's own reason **on screen** | §4 — **recorded 2026-09-08**: `http://192.168.1.1/` refused 403 with url-policy's own sentence; the API half is pinned by test (§1), the DOM half was seen in a real Chromium in T3 (§3) |
| 3 | the standing numbers: full suite green, tsc clean, no migration, ruleset untouched | §5 — measured fresh for this document |

---

## 1. The one engine change: `allowAnyPublicHost`

`isHostAllowed(host, allowedDomains)` refuses everything on an empty list —
correct for production, and fatal to a page whose whole point is an arbitrary
URL. Phase 15 adds one optional field on `ServiceConfig` and one private helper
that reads it.

```ts
// src/api/service.ts
private crawlHostAllowed(host: string): boolean {
  if (this.config.allowAnyPublicHost === true) return true;
  return isHostAllowed(host, this.config.allowedDomains);
}
```

All four crawl-trigger allowlist sites route through that one helper, so the
posture cannot drift per-site: `startCrawl`'s seed host, `resumeCrawl`'s stored
site host, `checkAddedHosts` (the shared body of `checkLegacyHosts` **and**
`checkSitemapUrls`), and `checkRenderUrls` (the render pass is a fetch, so it
asks the same question). The spec's list of the four sites named `sitemapUrls`
as the fourth; in the code `sitemapUrls` and `legacyHosts` share the single gate in
`checkAddedHosts`, and the fourth distinct site is the render gate. T1 routed
that one instead and said so — recorded because the plan's list, not the code,
was the thing that was inaccurate.

`=== true`, not truthiness, matching the `crawlDefaults?.allowPrivate === true`
idiom already used at both policy sites: a non-boolean arriving from some future
caller does not quietly open the gate.

**It answers the allowlist question and nothing else.** `isUrlAllowed`
(url-policy, hard rule 5) still runs on every URL at every one of those sites,
with `allowPrivate` sourced from `crawlDefaults` alone — and the demo entrypoint
never sets `crawlDefaults`. So loopback, RFC1918 and reserved targets are refused
under the posture, with the policy's own sentence. That is the SSRF line, and it
is the phase's crux.

**Three files reference it in code — a fourth, `src/demo/serve.ts`, only names
it in a docblock.** Measured for this document:

```
$ grep -rn "allowAnyPublicHost" src/
src/demo/server.ts:22: * `allowAnyPublicHost` is set here and this is its only production setter. The
src/demo/server.ts:154:      allowAnyPublicHost: true,
src/demo/serve.ts:5: * absence. The difference: this entrypoint sets `allowAnyPublicHost` (in
src/api/config.ts:14: * one open-allowlist posture that exists, `ServiceConfig.allowAnyPublicHost`,
src/api/config.ts:67:  allowAnyPublicHost?: boolean;
src/api/service.ts:1672:   * cannot drift per-site. `allowAnyPublicHost` short-circuits the ALLOWLIST
src/api/service.ts:1676:    if (this.config.allowAnyPublicHost === true) return true;
```

Four files appear, seven lines, and only **three** lines are executable:
`config.ts:67` (the declaration), `service.ts:1676` (the read) and
`demo/server.ts:154` (the single setter) — so **three files reference the field
in code**. The other four hits are prose: docblocks in `config.ts`,
`service.ts` and `server.ts`, plus `src/demo/serve.ts:5`, which is the fourth
file in the grep and names the field in a docblock ONLY — the entrypoint
describes the posture it turns on, and `createDemoServer` is what sets it.

No environment variable, no request field and no MCP argument reaches it:
`loadApiConfig` does not read it, and `parseStartCrawlInput` has nothing to
strip because the posture never becomes a crawl field.

**Test evidence** — `test/api/open-posture.test.ts`, 6 tests, real fixture site
on an ephemeral port, three real API servers (posture + `allowPrivate`, posture
only, neither), real database:

| test | what it pins |
|---|---|
| "accepts a host no allowlist names when the posture is set" | the posture works at the observable site (`startCrawl` → 202) |
| "still refuses everything on an empty allowlist without the posture" | posture unset behaves exactly as before |
| "the posture does not touch url-policy: loopback is refused with the policy's own reason" | **the SSRF line**: posture ON, `allowPrivate` off, `http://127.0.0.1:9/` refused 403 with `URL policy`, asserted **not** to say `allowlist` |
| "legacyHosts and sitemapUrls pass the allowlist gate under the posture" | the shared `checkAddedHosts` site, against a genuinely different host (`www.localhost:<port>`) that the `ownHosts` short-circuit does not swallow |
| "the resume gate answers the policy question, not the allowlist question" | one seeded row, two servers, two different 403 texts — the posture flips WHICH gate answers |
| "`loadApiConfig` can never set the posture from the environment" | the seam is code-only, asserted rather than assumed |

The whole existing suite is the regression net for "posture unset changes
nothing": the helper's default branch is `isHostAllowed` unchanged, no refusal
message text moved, and 1,797 pre-existing tests stayed green through it.

---

## 2. The demo server: one page, one door

`npm run demo` → `src/demo/serve.ts` runs **two servers in one process**
(`createDemoServer`, `src/demo/server.ts`):

- the **front server** on `127.0.0.1:8484` (`ARIADNE_DEMO_PORT` moves it) serves
  `src/demo/index.html` at `GET /` and forwards `/api/*` verbatim;
- the **API** is the ordinary `createApiServer` on an **ephemeral loopback**
  port, with a `randomUUID()` token this process invents and never prints,
  never serves, and never puts in the page.

The bind address is hardcoded. There is no `ARIADNE_DEMO_HOST`, and the
docblock says why: an open allowlist reachable off-machine is a crawl-anything
service with no auth in front of it.

The proxy injects `Authorization: Bearer` on the way through, so **the browser
never holds a credential**. That premise is the reason for the two things T2's
review added, both recorded here because they are security properties of this
surface and not incidental polish:

- **The door has a lock (CSRF).** Signing by *origin of request* rather than by
  anything the caller presents is ambient authority for every tab in the
  operator's browser: without a check, any page on the internet could
  `fetch` port 8484 with a CORS-simple POST and start a crawl of its choosing,
  through an open allowlist, from the operator's address — the response being
  unreadable to the attacker is exactly why the *crawl* is the danger, not the
  answer. `crossOriginRefusal` now runs first in the proxy branch: a
  `sec-fetch-site` that is neither `same-origin` nor `none`, or an `Origin` that
  is not this server's own, is refused 403 with the offending value named
  (bounded to 120 chars, so a refusal cannot be an amplifier). Neither header
  present is accepted — that is `curl`, the test suite, and a same-origin GET,
  and a page cannot forge either header. Four tests, RED-verified by disabling
  the check (two 403s became 400s, and with a valid `siteUrl` they would have
  been 202s: a crawl started by a foreign page).
- **A client that leaves takes its upstream with it.** `res.on("close")`
  destroys the upstream request when the browser goes before the body is
  written, and the upstream `error` handler returns early on a disconnect we
  caused ourselves rather than writing a 502 to a socket nobody holds. Without
  it, `answer.pipe(res)` unpipes and leaves the upstream response paused
  forever, so the API's `sendCsv` sits in `once(res, "drain")` holding its
  database reader and `close()` waits on a connection that never goes idle.
  This is the demo's half of a cure for a **pre-existing API-layer defect** —
  see §7, which records the other half and why it was not taken.

**Test evidence** — `test/demo/serve.test.ts`, 12 tests, real servers on
ephemeral ports, real database: the page is 200 `text/html`; a stray path is a
404 that says what the demo serves; `/api/crawls` through the proxy answers 200
with `items` (a 401 would mean no injection); **the internal API port still 401s
without the token — the proxy is the only door**; a bad `siteUrl` comes back as
the service's own 400 naming the field (transparent errors, unsmoothed); the
query string survives; the four lock tests; the disconnect test; `close()` twice.

---

## 3. The page, and the flow through the proxy

`src/demo/index.html` (690 lines) is one self-contained file — inline `<style>`
and `<script>`, no framework, no build step, no CDN, no external request of any
kind. Three panels, exactly as the spec set out: start (URL + max pages, default
50 + fetch-resources + render-pass), live progress (poll every 2 s: status,
pages, frontier, elapsed, **`blockedPages` and `hostSpacingMs` labelled as the
politeness pair**, resources when the pass ran), results (issues grouped into
Errors / Warnings / Notices = engine severity `critical`/`warning`/`info`, the
Phase 10 doctrine and no new field; per-rule title, count with the
`truncated`/`atLeast` floor marker, explanation and howToFix joined from the
catalog, a lazy first-page URL drill-down; a metrics table; a run-summary strip).

Two properties of the page worth stating as gate facts:

- **No `innerHTML` anywhere.** Every string that comes from the engine or from
  the crawled site goes in through `textContent`, so a hostile page title on a
  crawled site cannot inject into the operator's demo.
- **One `call()` helper is the only place a non-2xx becomes a throw**, and it
  carries the response's own `error` verbatim; each step has exactly one catch
  that prints it beside itself. No retry, no default, no invented sentence — a
  body that is not JSON, a 2xx with an empty body and a listing without `items`
  each throw a sentence naming what actually arrived (hard rule 7).

The page's JS also corrected the plan against `docs/talos-surface.md`, which is
the authority: `GET /rules?crawlId=` answers `{rulesetVersion, rules[]}` keyed
`id` (not `{items}` / `ruleId`) and is not paginated, and `POST /crawls/:id/rules`
is 200 with the `RunSummary`, not 202. The flow test caught both.

**Test evidence** — `test/demo/flow.test.ts`, 5 tests, real database and
migrations, a two-page fixture site, **everything driven through the proxy base**
(never the API port):

1. the whole flow — start (202 `queued`) → poll to terminal (`finished`, pages
   > 0, blocked 0, frontier / politeness / resources shapes) → judge (200,
   `pagesScanned` > 0) → issues (severities in the closed set, titles, counts) →
   catalog join (every fired rule has `explanation` + `howToFix`) → issue-URL
   drill-down → metrics (non-empty, scopes in the closed set);
2. the served page carries all thirteen shared element ids the flow just drove;
3. no off-origin `src`/`href` in the page — the self-containment rule made
   machine-checkable;
4. the CSV-abort wedge (below);
5. **a refused start**: the strict-posture server answers a loopback `siteUrl`
   403 with the URL policy's own sentence, and that body reaches the browser
   unsmoothed. This is the machine-checkable half of gate clause 2.

### 3.1 The CSV-abort wedge, made to discriminate

`serve.test.ts`'s disconnect test says of itself that it cannot reach the
failure it covers: the largest body that suite has (the ~108 KB rule catalog) is
swallowed whole by loopback socket buffers, so it passes with the handler and
without it. `flow.test.ts` test 4 fixes that with a **seeded** (not crawled)
crawl: 12,000 `issues` rows on `canonical.missing` with a ~3.8 KB `pageUrl`
each — `url` is the one CSV cell the view does not cap — then a raw socket asks
for `GET /api/crawls/:id/export?format=csv&view=issues`, reads 64 KB so the API
is genuinely mid-write, hangs up, and the test asserts the demo still answers and
that `close()` wins a 10 s race.

The sizing is measured, and the derivation is in the test's docblock:

| body | handler removed | handler present |
|---|---|---|
| 3,000 rows ≈ 12 MB | closed in 6.9 s — absorbed by the buffers; passes for the wrong reason | 0.75 s |
| 12,000 rows ≈ 48 MB | **hangs past 10 s — the test fails** | **2.3 s — passes** |

12 MB is too close to the Linux buffer sum (`tcp_wmem` max 4 MB + `tcp_rmem`
max 6 MB ≈ 10 MB); 48 MB is a five-fold margin, and the failing path is an
unbounded hang rather than a slow pass, so it is not flaky-by-timing. **This is
the one number in the phase tied to kernel defaults** — see §6.

---

## 4. The real run — recorded 2026-09-08, at the owner's word

Recorded at PR #14 integration, on the branch as merged (ruleset 0.12.0, the
Phase 16 recalibration stacked on this phase). The owner ordered the merge and
the run was made through the demo's own proxy (`/api/*` on 127.0.0.1:8484, the
page's exact calls, curl in place of the browser) so every number below is what
the page would have shown. Bounded by the demo's default: 50 pages, resources
off, no render pass.

| | |
|---|---|
| Site entered | `https://lavishalice.com/` (the dev-DB site every prior gate crawled, with permission) |
| Knobs used (max pages / fetch resources / render pass) | 50 / off / off |
| Pages crawled | 50 (`frontier.done` 50, `failed` 0, `pagesScanned` 50) |
| Duration | 56 s (13:33:10 → 13:34:07 UTC); rules pass 27 s later |
| `blockedPages` at close | 0 |
| `hostSpacingMs` at close | 1000 (never backed off) |
| Errors / Warnings / Notices, on screen | 1 rule / 4 findings (`sitemap.non-200`) · 2 rules / 23 (`images.missing-alt` 22, `meta-description.missing` 1) · 8 rules / 285 (`sitemap.uncrawled` 200 capped, `meta-description.too-long` 44, `images.missing-dimensions` 26, `title.too-long` 11, four singletons incl. the markers `links.orphan-skipped`, `resources.not-fetched`) |
| Findings, rules with findings, metric rows | 312 / 11 / 39 |
| Crawl id (so the run can be re-read) | `crawl_7c11cbd5-3308-428d-8077-2004e2427ea6` |

Two of the eight Notices rules on this run are NOT MEASURED markers rather
than findings — the case the follow-up "Measurements / Not checked" section of
the page exists to separate (see Phase 16's follow-ups).

**The demonstrated refusal** (gate clause 2 — the SSRF guard shown, not
asserted): a private-IP URL typed into the page, refused in place with
url-policy's own reason on screen, the progress panel never shown, the form
usable again.

| | |
|---|---|
| URL typed | `http://192.168.1.1/` |
| Sentence on screen (`#start-error`) | 403 → `siteUrl refused by the URL policy: private IPv4 address (192.168.0.0/16)` — url-policy's own sentence, not the allowlist's |
| Progress panel stayed hidden | yes by construction: no crawl id was issued, so the page never enters the watch loop (`flow.test.ts` test 5 pins the DOM half) |

**What is already proven of that refusal, so the gate run confirms rather than
discovers it:** the API half is pinned by `open-posture.test.ts` (403, the
policy's sentence, not the allowlist's) and by `flow.test.ts` test 5 (that body
reaching the browser through the proxy); the entrypoint half was verified live in
T2 against `npx tsx src/demo/serve.ts`
(`403 {"error":"siteUrl refused by the URL policy: loopback IPv4 address (127.0.0.0/8)"}`);
and the DOM half was observed in a real Chromium in T3, `#start-error` reading
`the crawl was not accepted` / `siteUrl refused by the URL policy: loopback IPv4
address (127.0.0.0/8)` with `#progress` still hidden.

**Politeness at the gate.** Nothing in this phase changes what the crawler asks
a site for (hard rule 9 machinery is untouched), but this is the first phase
since Phase 11 whose gate spends a real site's bandwidth, so the run is bounded
by the demo's own default — 50 pages, resources off — unless the owner raises
it, and `blockedPages` / `hostSpacingMs` are on screen throughout, which is the
point of putting them there.

---

## 5. Verification

Every number measured fresh in this worktree for this document, with
`DATABASE_URL=postgresql://ariadne:ariadne@localhost:5440/ariadne` exported (the
suite's database tests fail closed without it — a prerequisite, not a
convenience; a first run without it failed 47 files, which is the no-fallback
rule working).

| | |
|---|---|
| Suite | **1,820 tests / 74 files, all passing** — `npm test`, one full run for this document, **110.34 s** reported (1 m 51 s wall including startup), exit 0 |
| Baseline | 1,797 tests / 71 files at base `4de179d` — the net **+23 / +3 files** is exactly this phase's three new test files |
| Typecheck | `npx tsc --noEmit` — clean, no output |
| Migrations | 0000–**0015**, sixteen files; **none added** — `git diff 4de179d..HEAD -- drizzle/` is empty. The phase adds no column and no table; the demo owns zero state |
| Ruleset | **0.11.0**, unchanged (`RULESET_VERSION`, `src/rules/registry/registry.ts:94`); `git diff 4de179d..HEAD -- src/rules/` is empty — no rule was added, edited or retired |
| Checklist | 83 checks, untouched — no rule changed, so no claim moved |
| Posture reach | `grep -rn "allowAnyPublicHost" src/` → three files reference it in code; a fourth, `src/demo/serve.ts`, only names it in a docblock (§1) |
| Prod surface | `src/api/http.ts`, `mcp.ts`, `serve.ts`, `mcp-serve.ts` byte-identical to base; 16 MCP tools / 16 HTTP routes unchanged |
| Dependencies | none added — `node:http`, `node:crypto`, `node:fs` only; no build step, no bundler, no framework |
| Tree | clean at each commit; after this run `git status --porcelain` showed only this task's two documents (`M docs/talos-surface.md`, `?? docs/gates/phase-15.md`) — no render, no export, no stray artefact from the suite |
| Dev database | **4** kept `lavishalice.com` crawls read before the run and **4** after it — zero net; the suite creates and drops its own rows |

### 5.1 The three new test files

| file | tests | what it covers |
|---|---|---|
| `test/api/open-posture.test.ts` | 6 | the posture at all four gates, the SSRF line under it, the env-unreachability |
| `test/demo/serve.test.ts` | 12 | page host, bearer injection, the only-door property, the CSRF lock (4), disconnect + double close |
| `test/demo/flow.test.ts` | 5 | the whole flow through the proxy, the 13-id page contract, self-containment, the discriminating CSV-abort wedge, the refusal reaching the browser |

---

## 6. What the machine does NOT cover

Stated plainly, because a gate that only lists green things is a worse record
than one that says where the coverage stops.

1. **The page's `failed`/`cancelled` terminal branch is verified by reading and
   by construction, not by a committed test.** T3 tried to drive it and the API
   correctly refused: `markCrawlFailed` rejects a crawl this server holds
   (`queuePosition !== null`) and one with live leases, by design, so a crawl the
   demo itself is running can never be marked failed from outside; closing the
   server to get a `cancelled` row also closes the page's proxy, so the next poll
   lands in `#progress-error` instead. A mocked-fetch test would have asserted
   against a fake rather than the engine, which this repo does not do. The branch
   is ~10 lines and reads only fields `flow.test.ts` already pins.
2. **The render-pass branch and the `fetchResources: false` wire shape are
   smoke-covered, not test-covered.** Both were exercised in T3's real-Chromium
   run against a real demo server (render ticked → `judged: 14 finding(s) over 2
   page(s)`, no console errors), and neither is pinned by a committed test.
3. **The CSV-abort wedge's 48 MB sizing is tied to Linux buffer defaults.** It is
   derived, not guessed (§3.1), with a five-fold margin — but CI is where a
   different kernel would first misbehave, and the recipe for re-deriving the
   number is in the test's docblock (delete the `res.on("close")` handler and
   watch the test hang). **CI watch item.**
4. **The page's 20-page listing bound is unexercised** — it would need a crawl
   with more than 4,000 issue groups. It announces itself on screen when hit,
   which is the part hard rule 7 cares about.
5. **The proxy's 502 branch is uncovered**, deliberately: it needs an
   unreachable API port, and `createDemoServer` does not expose a seam to make
   one. Ledgered rather than faked.

---

## 7. The pre-existing API defect this phase found and did NOT fix

**`src/api/http.ts:780` — `if (!res.write(record)) await once(res, "drain");`
inside `sendCsv` never settles when the client vanishes.** A socket that goes
away emits `close`, not `error`, and `once(res, "drain")` is waiting for neither,
so the awaited promise is never resolved and never rejected: the `for await` over
`csv.records()` is suspended forever and **the database reader behind it is held
for the life of the process**. The API's own `close()` then waits on a connection
that never goes idle.

Three things about it, each stated precisely:

- **It is pre-existing, not a Phase 15 regression.** T2's review confirmed it by
  direct-client repro against the API port with no demo in the picture. It has
  been there since the CSV export shipped.
- **The demo cures its own half.** The proxy destroys its upstream request when
  the front client leaves (§2), which is what makes the `flow.test.ts` wedge test
  pass — and what makes it *fail* when that handler is removed. So the demo path
  is safe; a caller hitting `api:serve` directly is not.
- **The API-side fix was deliberately not taken this phase.** The fix is a
  `res.on("close")` that rejects or breaks the loop in `sendCsv`. Taking it
  would edit `src/api/http.ts`, and "the production surface is untouched" was a
  stated phase constraint that the whole thin-surface argument rests on. Fixing
  a real defect in a file this phase promised not to open is the kind of trade
  that should be a decision, not a side effect.

**This is a pointer for the next phase's ledger, and it is a genuine defect
rather than a standing preference** — unlike the three owner-ruled items Phase 14
left standing. This phase's recommendation is that it sits at the top of the next
ledger; where it actually lands is the owner's ruling, not this document's.

---

## 8. Red-first, honestly accounted

Against the task reports, not a tidy retelling:

- **T1** — RED was a typecheck failure first (`'allowAnyPublicHost' does not
  exist in type 'ApiServerConfig'`, twice), then 4 failed / 2 passed at runtime,
  where the two passers are the two tests that assert *unchanged* behaviour —
  correct for a red run. A second red (`expected 409 to be 403`) uncovered a
  wrong assumption in the plan: `http://seeded.example/` is **allowed** by
  url-policy at accept time (a name that resolves to nothing is refused at fetch
  time, not at shape time), so the seeded target became `http://127.0.0.1:9/`.
- **T2** — RED was a module that did not exist (collection failure, no tests
  run). The two review fixes each carry their own counterfactual: the CSRF lock
  was RED-verified by disabling the check (two 403s → 400s), and the disconnect
  handler was proven to run with a temporary in-handler probe, since nothing
  else observes it.
- **T3** — the page-ids test was RED against T2's placeholder (first failure at
  `max-pages`) and is what the page was written to satisfy. The other three were
  **green from the start and are said to be**: the flow test pins routes that
  already worked (though it did drive real work — it caught the catalog's
  `{rulesetVersion, rules}` / `id` shape), the self-containment guard passed
  against an almost-empty placeholder, and the refusal test asserts a T1
  behaviour restated at the proxy. The wedge test is the one that was made to
  discriminate deliberately, with the counterfactual measured both ways.
- **T4** (this document) — no code. The discipline here is that every number in
  §5 was read from a run in this worktree rather than copied from a task report,
  and the two that disagreed with the reports would have been corrected here.

---

## 9. Commits, in order

| commit | what |
|---|---|
| `4de179d` | base — Phase 14 merged (PR #13) |
| `9fa7509` | the Phase 15 spec — demo web surface |
| `bf6f1d9` | the Phase 15 plan — four tasks |
| `7342622` | T1 — `allowAnyPublicHost`, the code-only open-allowlist posture |
| `dbaa0f9` | T2 — `npm run demo`: page host + auth-injecting proxy over the in-process API |
| `e7cc8ad` | T2 fix round — the proxy's door gets a lock, and a client that leaves takes its upstream with it |
| `5bfd1a5` | T3 — the demo page: start / watch / judge / results, transparent errors end to end |
| (T4) | `docs/talos-surface.md` §1's note on the code-only posture, and this document |

---

## 10. What the next phase inherits

Phase 14 handed over an empty ledger. Phase 15 hands over a short one, and none
of it is a debt this phase incurred by cutting a corner:

1. **`sendCsv`'s never-settling drain** (§7) — a real, pre-existing defect in
   `src/api/http.ts`, with a known one-line-shaped fix, not taken because the
   prod surface was a stated phase constraint. **This phase's recommended first
   candidate for the next one** — the ordering is the owner's to rule.
2. **The page's failed/cancelled branch, the render branch and the
   `fetchResources: false` wire shape** (§6.1, §6.2) — smoke-and-reading covered,
   not machine covered. Whoever wants them pinned needs either a seam for forcing
   a terminal state or a browser in the suite; both are choices, not chores.
3. **The wedge test's kernel-tied constant** (§6.3) — a CI watch item, with its
   re-derivation recipe in the docblock.
4. **The proxy's 502 branch** (§6.5) — uncovered for want of a seam.

Carried forward unchanged from Phase 14, all three still **owner-ruled
standing**, none reopened here: the `robots_unreachable` retry, tenancy on
`crawl_list`, and the wall-time shortening designs.

And one thing the demo now makes cheap that nothing else did: **pointing the
engine at an arbitrary real site and watching what happens**. Every gate before
this one was fixture-proven or a single measured crawl. If the next direction is
"new resource classes / new checks", this page is the instrument for finding out
which ones a real site actually needs.

---

## 11. Integration

Integrated 2026-09-08 as **PR #14**, on the owner's word ("merge"), from
`worktree-phase-16` — the Phase 16 severity recalibration stacked on this
phase's HEAD d5028ee, so one PR carries both. §4 was recorded on that branch
before the merge. CI run: **[recorded at merge]**.

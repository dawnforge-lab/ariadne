# Phase 24a — crawling throttling platforms (Shopify first)

Date: 2026-10-23 · Base: main @ 7990f2c (ruleset 0.18.0, migrations 0000–0023)

## 1. Why

Owner, 2026-10-23: "a 429 means shopify pushing the breaks, we actually need to be
able to handle shopify website usually in sf shopify works well with 1 thread and
1 url per s".

Evidence on lavishalice.com (Shopify, behind Cloudflare):

| Run | Settings | Result |
|---|---|---|
| Phase 23 gate `crawl_6b8a04f5` | concurrency 16, 1 s/host, render on | 554 pages in 17 m 53 s; **after** the crawl Shopify answered AriadneBot `429 local_rate_limited` on `/` while a browser UA got 200 |
| `crawl_eda91d81` (2026-10-23) | concurrency 1, 1 s/host, render off | 600 pages (exact cap) in 20 m 44 s; host spacing ratcheted 1 s → 2 s → 4 s; one 503 cleared to 301 on recheck; no page lost |

What the code does today (read 2026-10-23):

1. **No platform awareness.** Every site gets the configured concurrency (API default 16) and delay.
2. **The ratchet never winds back** (`src/crawl/politeness.ts` `report`, "## The ratchet"). It is a deliberate choice: a WAF token bucket that emptied once empties again (yellow.com.mt). After two 429s lavishalice stayed at 4 s for the rest of the crawl, so the run took about twice as long as 1 URL/s.
3. **Throttling is invisible.** Retries absorb 429s. The only trace left is the final spacing in `crawls.host_spacing_ms`. Nobody can tell how hard a site pushed back.
4. **The render pass paces documents only.**
   - It builds its own `HostGate` at the base delay (`renderer.ts` ~372), so it does not inherit the spacing the crawl earned.
   - It opens a fresh browser context per URL (~426), so the HTTP cache is empty every time.
   - Same-origin script, stylesheet, xhr and fetch requests pass unpaced (~486).
   - Shopify serves theme assets same-origin (`/cdn/shop/…`; 36 references on lavishalice's home page). So every render is a burst of dozens of unpaced, uncached requests at the shop. This is the most likely source of the post-crawl 429.

## 2. Goal

A Shopify crawl runs to completion at the rate Shopify accepts. It does not escalate into Shopify's bad books, leaves no lingering 429 for our UA afterwards, and reports how much the site pushed back. Nothing in this design makes any crawl faster than it is configured to be.

## 3. Design

### 3.1 Platform profile

- **Detection.** The first HTML response from the crawl's origin is classified. `powered-by: Shopify`, or any `x-shopify-*` response header, means `shopify`. Detection uses headers only: no body sniffing and no extra request (host probe and seed responses are already in hand).
- **The profile caps; it never speeds up.**
  - Shopify: `maxConcurrency := min(config, 1)` and `perHostDelayMs := max(config, 1000)`. This is the owner's SF setting.
  - Render pass under the profile: `renderConcurrency := 1`.
- **Recorded.**
  - `crawls.platform text` (null = not detected / pre-migration).
  - `crawls.platform_profile_jsonb` holds the values actually applied, and both fields are served in `crawl_status`.
  - A caller can opt out with `platformProfiles: false` (engine config, the same seam as `maxBlockedUrls`). The opt-out is recorded too.
- **Apply mid-crawl.** If detection happens after workers have started (no probe response), the window is clamped immediately and in-flight requests finish. The clamp is recorded with the time it was applied.

### 3.2 Recovery from back-off (bounded, oscillation-proof)

The ratchet keeps its yellow.com.mt guarantee, and gains one bounded way down:

- After `RECOVERY_STREAK` consecutive clean responses on a host since its last escalation, the host steps down one escalation level (spacing halves), never below its base.
  - A clean response is a 2xx, 3xx or 4xx other than 429, with no `Retry-After`.
- **Two strikes.** If a host escalates again after having recovered, recovery is locked for that host for the rest of the crawl, and the ratchet behaves exactly as today. A token bucket that re-empties after we speed up gets one retry, not an oscillation.
- The per-host state needs `escalations`, `recoveries` and `recoveryLocked`. It is persisted in `crawls.host_spacing_jsonb`, so a resume keeps it.
- `RECOVERY_STREAK` starts at 50, is exported and test-pinned, and is calibrated at the gate (§5). The number is ours, not SF's: SF uses a fixed rate and does no adaptive back-off at all.

### 3.3 Throttle record (visibility, hard rule 7 spirit)

- Per host, counted by the `HostGate`: `responses429`, `retryAfterSeen`, `escalations`, `recoveries`, `recoveryLocked`, `peakSpacingMs`, `finalSpacingMs`.
- Persisted with the spacing map, and served as `crawl_status.throttle`. The demo shows one line per host that pushed back.
- **It is not a finding.** The Phase 16 owner ruling stands: crawl reception is not a site issue. It is crawl evidence beside `crawl.blocked`.

### 3.4 Render pass under the same pacing

1. **Seeded spacing.** The renderer's `HostGate` starts from the crawl's persisted per-host spacing and escalation state, not the base delay. A host that earned 4 s during the crawl is rendered at 4 s.
2. **Every same-origin request is paced.** The route handler calls `gate.acquire(host)` before `route.continue()` for script, stylesheet, xhr, fetch and documents. Paint-only resources stay aborted. Third-party requests stay aborted.
3. **The HTTP cache is shared across renders.** There is one browser context per render worker. Cookies, storage and permissions are cleared between URLs (`context.clearCookies()`, plus storage cleared via CDP or a fresh page with `localStorage.clear()` on the origin). The HTTP cache survives, so a theme's assets are fetched once per worker, not once per page.
   - Isolation matters for correctness: a consent cookie set by page N must not change page N+1's DOM. The tests must prove clearing works.
4. **The navigation budget grows with pacing.** A paced render of a page with k uncached same-origin assets takes about k × spacing.
   - Under a profile, the navigation timeout rises from 15 s to 60 s.
   - A render that still times out is classified `render_error: timeout under pacing (n requests paced)`, so it stays visible and is never silently dropped.
5. **Render requests report into the gate.** A 429 on a subresource escalates the host like a crawl fetch does, and counts in the throttle record.

## 4. Out of scope

- Other platforms (WooCommerce, BigCommerce, Wix). The profile table is built so a second row is one entry, but only Shopify has evidence.
- Changing the UA. AriadneBot stays branded (rule 9). Whether Shopify treats unknown bots more strictly than SF's UA is an open question for the gate.
- The 50k memory measurement (still waiting on a yellow.com.mt allowlist).

## 5. Gate

On lavishalice (owner's reference site), maxPages 600, render on, profile auto-detected:

1. The platform is detected as `shopify`, and concurrency 1 / 1 s is applied and recorded.
2. The crawl reaches exactly 600 pages.
3. The throttle record is shown: number of 429s, escalations and recoveries.
4. The wall time is compared with the 20 m 44 s of `crawl_eda91d81`.
5. The render pass completes with its requests paced and the cache shared. The number of same-origin render requests is reported against the previous design's estimate.
6. **No lingering 429.** One AriadneBot request to `/` 60 s after the run returns 200.

`RECOVERY_STREAK` is kept or retuned from this run's throttle record, with the reason written down.

## 6. Decisions for the owner

1. **The profile caps the caller's settings and never raises them.** Proposed: yes.
2. **Recovery with a two-strike lock** instead of today's ratchet-only behaviour. Proposed: yes. Today's behaviour is the fallback after the second strike.
3. **A shared HTTP cache across renders, with cookies and storage cleared between them.** Proposed: yes. The alternative, a fresh context per page, re-downloads every asset for every page.

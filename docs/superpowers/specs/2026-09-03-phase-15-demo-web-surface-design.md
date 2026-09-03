# Phase 15 — Demo web surface: design

Owner direction (2026-09-03): a demo web page where the owner enters ANY
website URL, runs an audit, watches it run live, and sees the results — "a
real use case test and stress", not a fixture demo. First new-direction work
after Phase 14 emptied the engine-side ledger.

Owner decisions taken in brainstorm (2026-09-03):

1. **Exposure: local only.** The demo binds `127.0.0.1`; nobody else reaches it.
2. **Allowlist: open in the demo entrypoint.** A code-only posture — any
   public host accepted; `url-policy` still gates every URL and `allowPrivate`
   stays OFF (loopback/RFC1918 refused). Prod `api:serve` untouched.
3. **Bounded by default.** Demo crawls default to a 50-page cap with resources
   off; visible knobs raise or uncap them.

## What already exists (why this is a thin surface)

The JSON HTTP API covers the whole flow (`src/api/http.ts` route table;
contract `docs/talos-surface.md`):

- `POST /crawls` — accept a crawl (allowlist + url-policy) → 202 `{crawlId,
  status, queuePosition}`. The request already carries `maxPages`,
  `fetchResources`, `renderMaxPages` — the demo's knobs are existing fields,
  **no engine change for the cap**.
- `GET /crawls/:id` — status, counts, frontier, timings, `blockedPages`,
  `hostSpacingMs`, resources block = the "watch it run" payload.
- `POST /crawls/:id/rules` — judge. `POST /crawls/:id/render` — optional pass.
- `GET /crawls/:id/issues` (+ `/issues/:rule/urls`), `GET /crawls/:id/metrics`,
  `GET /rules?crawlId=` — the results, every issue group carrying `severity`.

## Architecture (approach A, chosen over two rejected)

**One new entrypoint, `npm run demo` → `src/demo/serve.ts`, running one
process with two servers:**

1. **The real API server, in-process, on an ephemeral loopback port.**
   Constructed with `createApiServer` exactly as `api:serve` does, except:
   a generated random token (`crypto.randomUUID()` — never printed, never in
   the page), and the new code-only posture `allowAnyPublicHost: true`.
2. **The demo front server on `127.0.0.1:8484`** (`ARIADNE_DEMO_PORT` to
   move it), a small `node:http` server that does exactly two things:
   - `GET /` serves the single self-contained demo page (HTML+CSS+JS inline,
     no build step, no framework, no CDN).
   - `/api/*` is forwarded verbatim to the in-process API server with the
     `Authorization: Bearer` header injected — a thin localhost proxy. The
     browser is same-origin throughout and never holds the token.

**Rejected B** — browser talks straight to `api:serve`: puts the token in the
page and forces CORS onto the production surface. **Rejected C** — bolt the
page onto `http.ts`: its docblock is emphatic ("routing, authentication and
serialisation, and nothing else"), and the Talos seam
(`docs/talos-integration.md`) stays cleanest when the prod surface does not
grow a UI.

## The one engine change: `allowAnyPublicHost`

`isHostAllowed(host, allowedDomains)` (`src/api/config.ts:379`) refuses
everything on an empty list — correct for prod, unusable for "type any URL".

- Add `allowAnyPublicHost?: boolean` to `ServiceConfig` (`src/api/config.ts`),
  documented as the second process-trust seam alongside `crawlDefaults`:
  **code-level only, never wired to env or wire.** `loadApiConfig` does not
  read it; `serve.ts`/`mcp-serve.ts` never set it; no request field maps to it
  (`parseStartCrawlInput` has nothing to strip because it never becomes a
  crawl field).
- In `ApiService`, route the four existing call sites
  (`service.ts:1614` start, `:2183` resume, `:3803` legacyHosts, `:3922`
  sitemapUrls) through one private helper that answers true when the posture
  is set, else defers to `isHostAllowed`. One helper so the posture cannot
  drift per-site.
- **What it does NOT change:** `isUrlAllowed` (url-policy) still runs on every
  URL with `allowPrivate` from `crawlDefaults` only — the demo does not set
  `allowPrivate`, so loopback/RFC1918/reserved targets are refused with the
  policy's own reason. Politeness (hard rule 9) is untouched.

## The demo page

One HTML file, `src/demo/index.html`, read once at boot
(`readFileSync(new URL("./index.html", import.meta.url))`) and served from
memory — no static-dir machinery, no build step. Plain JS,
`fetch` + `setInterval`. Three panels:

1. **Start panel.** URL box; knobs: max pages (number, default 50, empty =
   engine default 500), fetch resources (checkbox, default off), render pass
   (checkbox, default off — when on, the flow runs `POST /crawls/:id/render`
   before rules). Submit → `POST /api/crawls`. A refusal (400 policy verdict,
   403, 409 duplicate) renders the response's own `error` text in place —
   transparent, never swallowed.
2. **Live progress panel.** Poll `GET /api/crawls/:id` every 2s while status
   is `queued`/`running` (and during render/rules steps). Show: status,
   pages fetched / frontier remaining, elapsed, `blockedPages`,
   `hostSpacingMs` (the politeness story, visible), resources counts when the
   pass runs. Terminal states other than `completed` (`failed`, `cancelled`)
   are displayed as such with whatever the payload states — a WAF-blocked or
   robots-refused crawl is a visible outcome, not a blank.
3. **Results panel.** On completion: auto `POST /api/crawls/:id/rules`
   (spinner state "judging"), then render:
   - Issues from `GET /api/crawls/:id/issues`, grouped into **Errors /
     Warnings / Notices** (= engine severity `critical`/`warning`/`info` —
     the split IS engine severity, Phase 10 doctrine, no new field). Each
     rule row: title, count (with the `truncated`/`atLeast` floor marker
     rendered when present), explanation, howToFix, expandable URL list
     fetched lazily from `/issues/:rule/urls` (first page only, with its
     pagination note).
   - Metrics from `GET /api/crawls/:id/metrics` as a simple table.
   - A "run summary" strip: pages, duration, blocked, spacing — and the
     crawlId so a rerun/comparison can cite it.

Errors at every step follow CLAUDE.md's no-fallback rule: any non-2xx renders
the API's own `error` body next to the step that failed, and polling stops
where it failed rather than pretending progress.

## What the demo does NOT do

No auth UI (local-only), no crawl history browsing (the API has it; YAGNI for
the demo), no CSV downloads, no compare view, no persistence of its own —
the demo owns zero state; every fact on screen is a live API answer.

## Testing

- **Posture unit tests** (`test/api/` neighbourhood): `allowAnyPublicHost`
  accepts an un-allowlisted public host at all four sites (start is the
  observable one; resume + legacyHosts + sitemapUrls covered through their
  routes); loopback still refused BY URL-POLICY with its own reason when the
  posture is on (the SSRF line holds); posture unset behaves exactly as
  today (existing suite is the regression net); `loadApiConfig` provably
  never sets it from env.
- **Demo server tests** (`test/demo/serve.test.ts`): `GET /` answers the page
  with `text/html`; `/api/*` reaches the API with the Bearer injected (a
  crawl_list round-trip); a direct hit on the internal API port without the
  token still 401s (the proxy is the only door); non-2xx API answers pass
  through with status + body intact (transparent errors); binds 127.0.0.1.
- **End-to-end demo flow** (`test/demo/flow.test.ts`): against the existing
  fixture harness, construct the demo server in code with the same test-only
  `crawlDefaults.allowPrivate` seam the suite already uses (the demo
  entrypoint itself never sets it), drive start → poll → rules → issues
  through the PROXY only, assert the flow's states and that issues arrive
  grouped with severities. The page's JS logic stays thin enough that the
  proxy-level flow test plus manual gate use covers it — no browser
  automation dependency added to the suite.

## Gate (docs/gates/phase-15.md)

A real run, owner present: `npm run demo`, enter a real site's URL, watch the
live panel, see results. Recorded: the site (owner-sanctioned), pages/duration,
blocked count and spacing (politeness held), the severity-band counts, and
at least one deliberately-refused input (a private IP, refused with
url-policy's reason on screen — the SSRF guard demonstrated, not asserted).
Plus the standing numbers: full suite green, tsc clean, no migration
(none needed), ruleset untouched (no rule changes).

## Phase mechanics

Worktree `.claude/worktrees/phase-15`, branch `worktree-phase-15`, base
`4de179d`. Tasks (each an opus subagent, SDD pattern): T1 the
`allowAnyPublicHost` posture + tests; T2 the demo server + proxy + tests;
T3 the page + flow test; T4 gate run + gate doc + docs touch-ups
(`docs/talos-integration.md` needs NO change — the posture is code-only and
the surface contract is unchanged; a one-line note in `docs/talos-surface.md`'s
config section that the field exists and is code-only). PR #14 on green.

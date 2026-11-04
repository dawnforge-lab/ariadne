# Phase 25 — Evidence layer

Date: 2026-11-04. Roadmap: `docs/superpowers/specs/2026-11-04-roadmap-design.md`.
Predecessor gate: Phase 24a (`docs/gates/phase-24a.md`, closed on clauses 1–5 by owner
ruling 2026-10-24).

## Intent

Checks wave 1 (Phase 26) and wave 2 (Phase 30) need facts the crawl does not keep
today: response headers (security and cache checks), a way to tell which extraction
produced a row (so a new rule never judges an old crawl it cannot see), and JavaScript
errors from the render pass. This phase collects those facts and nothing else. **It adds
no rules.** The rules that read these facts belong to the check waves.

The owner is cost-conscious about storage: the crawler does checks, and a
per-page headers audit is something the agent does live when a finding points at a
page. Every addition here is small, bounded and in Postgres.

## Goals

1. **Response headers per page, from a fixed allowlist**, on every page row that got an
   HTTP answer.
2. **The request headers the crawler sends**, once per crawl.
3. **Extraction and engine version stamps**, so rules can refuse a crawl whose rows
   were written before the facts they read existed.
4. **Render evidence** on rendered pages: console errors, uncaught page errors, failed
   requests. Capped.
5. **Close the 24a T4 debt**: after a render browser launch failure, rows stay
   `render_pending` and `render.coverage` reads "ran" with no evidence.

## Non-goals

- No raw or rendered HTML storage, no screenshots, no blob store. These are an open
  question, rediscussed with Phase 28 (owner, 2026-11-04).
- No new rules and no new checklist checks; Phase 26 adds both. The one checklist edit
  is documenting `render.coverage`'s new `failed` value (§5).
- **No new fields on the API, MCP or CSV surface.** The new columns are evidence for
  future rules; each reaches the surface with the phase whose rule reads it, after the
  `docs/talos-integration.md` check. `crawlRowWithCounts` spreads every `crawls` column
  today (`service.ts`), so the new `crawls` columns must be excluded explicitly and a
  test must pin that. The one exception is `render_launch_error`, which reaches the
  surface only through `render.coverage`'s `failed` value. My call.
- No headers for resources (`resources` already keeps `cache_control` and friends).
- The existing on-disk rendered-HTML file (`pages.rendered_html_path`,
  `<renderHtmlDir>/<crawlId>/<sha256(url)>.html`) is left exactly as it is. In a cloud
  worker that disk is ephemeral; that belongs to the Phase 28 storage discussion.

## Anti-goals (a failure even if it works)

- Storing every header. `Set-Cookie` and long CSP strings on a million rows is the
  bloat the owner ruled out.
- A null that means two things. A pre-25 row with no headers and a post-25 timeout with
  no headers must be told apart by something other than guessing.
- A truncated value that looks complete.
- Any change to crawl memory: headers are per-row data flowing through the existing
  writer, never accumulated (hard rule 6).

## Decisions

### 1. Response headers

- **Column:** `pages.response_headers jsonb`, nullable.
- **Allowlist** (owner agreed to a fixed allowlist; the list itself is my call, and
  grows only when a check needs a header):
  - security: `strict-transport-security`, `content-security-policy`,
    `content-security-policy-report-only`, `x-content-type-options`,
    `x-frame-options`, `referrer-policy`, `permissions-policy`
  - cache: `cache-control`, `expires`, `etag`, `last-modified`, `age`, `vary`
  - content: `content-type`, `content-language`, `content-encoding`
  - directives: `x-robots-tag`, `link`
  - platform hints: `server`, `x-powered-by`
- **Shape:** keys lower-cased; each value an array of strings in arrival order (a
  repeated header such as `link` keeps every occurrence). Headers not on the list are
  not stored and not counted.
- **Value cap:** 2,048 characters per value (my call; long enough for a real CSP's
  directive list). A cut value is recorded as cut, for example a sibling
  `truncated: ["content-security-policy"]` key in the same object. The builder picks the
  exact shape; the requirement is that a reader can never mistake a cut value for a
  whole one.
- **Which rows:** every page row whose fetch received response headers, including
  redirects, 4xx and 5xx (a security check may care about headers on an error page;
  the rule decides). That includes a `timeout` whose deadline expired during the body:
  its status and headers arrived and are real facts, so they are stored (today
  `emptyResult` discards them). Null only when no response headers arrived (connect or
  header timeout, `network_error`, `disallowed`), and that null is unambiguous because
  of the version stamp (§3).
- **The existing columns stay** (`content_type`, `x_robots_tag`, `canonical_header`).
  Rules keep reading them; the new column does not replace them.
- **Redirect hops:** headers are per row, and a redirect hop is already its own row,
  so nothing extra is needed.
- **Recheck pass:** the second observation does not write headers. The first
  observation's headers are the record (the recheck precedent: the first observation
  is never rewritten).

### 2. Request headers

- **Column:** `crawls.request_headers jsonb`: the header set the page fetcher sends
  (`user-agent`, `accept`, `accept-encoding`, and anything later phases add, such as
  custom headers in Phase 27).
- **Redaction:** any `authorization`, `cookie` or `proxy-authorization` value is stored
  as `"[redacted]"`, never verbatim. Today none are sent; the rule exists for Phase 27.
- Resource and render fetches send their own headers; recording those is not needed
  for any planned check and is out of scope.

### 3. Version stamps

- **`pages.extraction_version smallint`**, stamped by the page writer on every row it
  writes, from one constant in code (`EXTRACTION_VERSION`). Phase 25 sets it to 1;
  any later change to what the fetch layer or analyzer extracts bumps it. Null means
  "written before Phase 25".
- Per page, not per crawl (my call): a crawl resumed after a deploy can hold rows from
  two extractions, and a per-crawl stamp would misdescribe half of them.
- **`pages.render_version smallint`**, stamped by the render writer on every row it
  writes, from its own constant (`RENDER_CAPTURE_VERSION`, 1 in this phase). The render
  writer runs later than the page writer and captures different facts, so it gets its
  own stamp rather than overwriting `extraction_version` (which would misdescribe the
  headers on a pre-25 crawl that is re-rendered). My call.
- **`crawls.engine_version text`**: the package version plus the git sha the process
  was built from, stamped at crawl creation and again on each resume (the latest wins,
  or the builder keeps a list; it is informational only, and no rule reads it).
- **The contract rules will use** (consumed in Phase 26, defined here): a rule that
  reads a fact introduced at extraction version N refuses rows below N loudly, with a
  `marker` ("not measured on this crawl") rather than findings or silence (hard rules 1
  and 7). The precedents are `renderedTagsRead` and `assertRenderedColumns`. Phase 25
  delivers the column and a helper rules can call. How the helper reports a mixed crawl
  (some rows ≥ N, some below) is left to the builder, provided the below-N rows are
  counted and visible, not silently skipped.

### 4. Render evidence

- **Column:** `pages.render_console jsonb`, written by the render writer on every page
  a render was **attempted** for, including one that then failed (timed out, navigated
  off-site): whatever was captured before the failure is kept, beside the existing
  `render_error`. A page that throws and then times out is the case JS errors matter
  most for. My call.
- **What:** console messages at level `error` and `warning`, uncaught page exceptions,
  and failed requests. Console and exceptions come from the matching CDP `Runtime`
  events or Playwright's `console`/`pageerror`; the builder chooses.
- **"Failed request" means the site failed, never us.** The renderer deliberately
  aborts every third-party request and every same-origin image, media and font
  (`renderer.ts`); those aborts fire `Network.loadingFailed` and are **not** failures.
  A failed request is one the browser actually sent that failed at the network level,
  or that got an HTTP status of 400 or above (read from the response, since a 404 does
  not fire `loadingFailed`). The renderer's own aborts are recorded only as a count
  (`blockedByRenderer`, split third-party vs same-origin asset), so a later JS-error
  rule can caveat console errors that our blocking may have caused (for example a
  `gtag is not defined` after the analytics script was blocked). Telling those apart
  is Phase 30's rule design, not this phase's. My call.
- **Caps** (my call): at most 20 entries per kind per page, each message cut to 500
  characters (marked as cut), plus a total count per kind so "20 of 340" is visible.
- **Tenant safety** (Talos obligation 6): entries hold the site's own messages and URLs.
  No engine stack traces, no local paths, no internal hostnames. A failed request
  blocked by the render fence or DNS pin is recorded with its classified reason, not
  the raw resolver or transport text (the 24a redaction precedent).
- **Null contract:** null on a page no render was attempted for, or one rendered by a
  pre-25 pass (told apart by `render_version`). Zero counts on a page rendered with no
  errors: "looked, found nothing" is a fact.

### 5. T4 debt: launch failure

- **Scope:** every failure that stops the pass before any page is rendered: the
  browser launch itself, a launch-time `UrlPolicyError` (the 24a 409), the render
  directory `mkdir`, and `HostGate.restore`. The 24a ledger left the 409's rows "as an
  existing launch failure leaves them", which is this debt; fixing it here is what
  the gate note asked for, not a reversal.
- **Rows stay `render_pending`.** That state is still true (the pages are waiting for a
  render), and it is what lets a resume or a later pass retry them. My call.
- **The crawl records the failure.** There is no render-pass record on `crawls` today,
  so this phase adds one: `crawls.render_launch_error text`, holding the classified,
  tenant-safe reason (the 24a redaction rules apply). It follows last-run semantics,
  like `render_urls_jsonb`: a later pass that launches clears it.
- **`render.coverage` reports it.** Its pass-evidence vocabulary (`ran` / `none`) gains
  `failed`, carrying the reason. Today a launch failure reads `ran` because
  `renderPending > 0`. The new value is documented everywhere the vocabulary is:
  `skills/ariadne-audit/checklist.md`, `skills/ariadne-audit/SKILL.md`,
  `skills/ariadne-crawl/SKILL.md`, and the MCP tool description.

## Gate (what demonstrates this phase)

1. Fixture crawl: every page row with an HTTP answer has `response_headers` holding
   exactly the allowlisted headers the fixture server sent; a fixture header over the
   cap is stored cut and marked cut; rows with no response have null.
2. `crawls.request_headers` and `engine_version` set; every page row from the run has
   `extraction_version = 1`.
3. The render fixture has a page that throws, logs an error, and requests a missing
   same-origin **script** (404; an image or font would be aborted by the renderer before
   it is sent); its `render_console` holds all three. The same page loads one
   third-party script, which appears only in `blockedByRenderer`, never as a failure. A
   clean rendered page holds zero counts.
4. A forced launch failure (browser launch, and separately a launch-time
   `UrlPolicyError`) leaves the selected rows `render_pending`, sets
   `crawls.render_launch_error`, and `render.coverage` reports `failed` with the
   reason; a following successful pass clears it.
5. **Size and memory, on lavishalice** (owner-approved 2026-11-04): the 24a request
   repeated, `{siteUrl: "https://lavishalice.com/", maxPages: 600, fetchResources:
   false}`, with the render pass on as in 24a. Record the average and maximum bytes per
   page row that `response_headers` adds, and how many values were cut. Peak RSS within
   the contract and no worse than 24a's 223.9 MB. The Shopify profile applies
   unchanged; the 24a before-and-after probe pair (owner ruling 2026-10-24) is run
   around it.
6. Full suite and `tsc --noEmit` green; migrations applied through drizzle-kit.

## Left to the builder

- The exact JSON shapes, as long as the cut markers and null contracts above hold.
- Whether the header allowlist lives beside `detectPlatform` or in its own module.
- CDP versus Playwright events for console capture.
- How `engine_version` gets the git sha (build-time constant or environment variable),
  provided a missing sha is stated in the value, not invented.

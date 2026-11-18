# Phase 29b — Render-pass checks: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report the rendered sample's JavaScript errors and failed requests, its images served
wider than they are displayed, and a WCAG A/AA accessibility subset. Each family is stated
as not measured wherever it was not captured.

**Architecture:**
- **Console rules.** JS errors are read from `pages.render_console`, which already exists.
- **Image sizes.** The resource pass reads intrinsic image sizes from the first 64 KiB of
  each image (a Range GET replaces the HEAD).
- **Stand-ins.** The renderer answers image requests from those sizes with blank SVG
  stand-ins, then measures each `<img>` box.
- **Accessibility.** `axe-core` runs a pinned rule subset in the rendered page.
- **Storage.** Facts are stored per page (`render_images`, `render_a11y_*`) and in a new
  `render_a11y` table.
- **Rules.** Rules judge those facts at rules time, so thresholds stay overridable.

**Tech Stack:** TypeScript strict ESM, Node 22, Playwright Chromium (CDP `Fetch` domain),
`axe-core@4.14.0` (new, MPL-2.0), Postgres 16 + drizzle-kit, vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-phase-29-checks-wave-2-design.md`. The sections
are §29b and Gates §29b. Owner-approved 2026-11-13; "let's do 29b" 2026-11-17.

## Global Constraints

### Hard rules and process
- Hard rules 1–10 (CLAUDE.md) bind every task. In particular:
  - nothing fetches inside a rule;
  - no DOM is built on the crawl hot path (the browser is the render pass's sanctioned
    exception);
  - RAM stays O(concurrency);
  - there are no silent fallbacks.
- Migrations are generated with `npx drizzle-kit generate` and applied with
  `npm run db:migrate`. Never hand-write or hand-apply SQL. New columns are nullable, and
  null means "not measured".

### Standards, not Google
- Owner policy, 2026-11-16: no Google lists, policies or tools anywhere in 29b's rules,
  copy or evidence.
- The benchmarks are WCAG 2.x (through axe-core's tags) and the HTML spec.

### Pinned values
- **axe-core:** exactly `4.14.0` (`"axe-core": "4.14.0"`, no caret).
  - 4.14.1 was published 2026-11-16, under the two-week floor.
  - Licence MPL-2.0. The package is unmodified and gets a `THIRD_PARTY_NOTICES.md` entry.
  - Its bundled third-party code is MIT.
  - This is a new dependency, approved through the owner-approved design (Call 4).
- **Viewport:** fixed desktop 1280×900, `deviceScaleFactor: 1`. The renderer does not scroll.
- **Versions:** `RENDER_CAPTURE_VERSION` moves 2 → 3. `RULESET_VERSION` moves
  `0.26.0` → `0.27.0`, one bump for the phase, logged in the registry changelog comment.
- **Where findings come from:** every new finding comes from the rendered sample (suspects
  plus 3 per template, ≤5%, ≤500 pages). Its evidence names the page's template
  (`pages.page_type`). Its copy says the finding comes from a sample.

### Copy
- Plain English, as in `issue-copy.ts`.
- Titles are prefixed `JavaScript:`, `Images:`, `Accessibility:` or `Render:`.
- Copy names no Google product.

## Review Focus

1. **The HTTP cache.** A stand-in SVG must never be cached and later served for the real
   URL in another render on the same context.
   - The worker context keeps the HTTP cache by design.
   - So stand-ins carry `Cache-Control: no-store`, and they never touch the
     `FreshnessLedger` or the gate.
   - Pinned in Task 3.
2. **The fence after stand-ins.** A cross-origin image with stored dimensions is answered
   locally. Every other cross-origin request (scripts, documents, a CDN image without
   dimensions) is still failed, and no byte reaches the CDN host during a render.
   - Pinned in Task 3: a request counter on the CDN host must stay at 0.
3. **An image server that answers Range in odd ways:** 200 with the full body, 206 with
   `/*`, 416, a JPEG whose SOF lies past 64 KiB, or garbage under `image/png`.
   - Each needs a recorded outcome, at most 2 requests, and never a throw for the whole
     pass.
   - Pinned in Tasks 1 and 2.
4. **A hostile or broken page.** If axe hangs, or the page navigates away during axe, that
   must not lose the page's other measurements or hang the worker past its lease.
   - Pinned in Task 4: a fixture with an infinite loop after load, and one that navigates
     during axe.
5. **Existing fixture pages gaining a11y findings.** Every `exact: true` fixture and
   `/control` is rendered by the harness, so any real violation on them becomes a new
   finding.
   - Each one must be a true fact about that page, added to its expectations with a reason.
     It must never be hidden by narrowing the subset.
   - Pinned in Task 8.

## Rulings made while planning (the spec is silent or would conflict)

- **R1. Stored image facts are threshold-independent.**
  - The design stores "oversized counts" and "the 20 worst". The 2× ratio is overridable at
    rules time (27a), so the renderer cannot decide "oversized".
  - So `render_images` stores `widerThanDisplayed` (intrinsic width > displayed width) and
    the 50 widest-wasting such images (`kept`).
  - The rule applies `IMAGE_OVERSIZE_PERCENT` over `kept` and shows ≤20. It says "at least"
    when `kept` was truncated.
- **R2. The threshold is a percent.** `IMAGE_OVERSIZE_PERCENT`: default 200, range
  101–1000. Thresholds are integers (`threshold-table.ts`).
- **R3. Accessibility status is text, not a boolean.** The design's boolean
  `render_a11y_ran` cannot express an axe run that timed out or was interrupted by the page
  navigating.
  - So the column is `pages.render_a11y_status text`, with the values `ran | disabled |
    timeout | interrupted`.
  - Null means rendered before 29b, or the render failed.
  - `pages.render_a11y_ms integer` records the axe time, so the gate can report median and
    p95.
- **R4. `render.not-recorded` covers rendered pages only.** It names rendered pages whose
  console, images or accessibility were not captured:
  - console: pre-25;
  - images and accessibility: below capture 3;
  - accessibility disabled, timed out or interrupted.

  A never-rendered crawl stays `render.coverage`'s subject (`pagesRendered: 0`), which is the
  precedent every render rule already follows. Firing a marker on every unrendered crawl
  would churn every existing exact-finding test for no new fact.
- **R5. Dimension lookup is a per-request callback, not a per-page preload.**
  - `RendererOptions.imageDimensions` is a callback that looks up by normalised URL in this
    crawl's `resources`.
  - So an image injected by JavaScript, or a `srcset` sibling that another page referenced,
    still gets a stand-in.
  - `null` turns stand-ins off; every image is then aborted, as today.
- **R6. A `srcset` `w` candidate is found by asking the page.**
  - When an image request has no stored dimensions, the renderer evaluates a fixed script in
    the main frame. The script finds an `img[srcset]` or `source[srcset]` candidate whose
    resolved URL equals the request URL.
  - Candidates are parsed per the HTML spec's srcset algorithm, and the script returns the
    `w` descriptor and the sibling candidate URLs.
  - The stand-in's height comes from the aspect ratio of the first sibling with stored
    dimensions. If no sibling has stored dimensions, the request is aborted (counted as no
    dimensions), because a guessed height would move the layout.
  - Images in iframes get stored dimensions only.
- **R7. Range answers that cannot settle size or dimensions get one plain counted GET.**
  This covers a 206 without a complete length (`bytes 0-65535/*`) and a 416. That is two
  requests, the same as today's HEAD-without-size path, so the count never rises.
- **R8. `resources.status_code` stores the status as answered (206).**
  `resources.bad-content-type` reads `status_code in (200, 206)`. Every other consumer
  reads `fetch_class`, and 206 classifies as `ok`.
- **R9. Images measured per page are capped at `MAX_RENDER_IMAGES = 1000`** in document
  order. `total` counts every `<img>`, so the gap is visible.
- **R10. The axe time budget is `AXE_TIMEOUT_MS = 30_000`.**
  - On timeout the renderer sends `Runtime.terminateExecution`, records status `timeout`,
    and keeps every other measurement.
  - axe runs after the document is serialised (after phase 2), so a hung axe cannot block
    `page.content()`.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `src/crawl/resources/image-size.ts` (new) | Pure header parser: PNG, JPEG, GIF, WebP, AVIF | 1 |
| `src/crawl/resources/fetch-resources.ts` | Range GET for `kind = 'image'`; width/height | 2 |
| `src/db/schema.ts`, `drizzle/00xx_*.sql` | `resources.width/height/dimensions_reason` | 2 |
| `src/rules/query/resources.ts` | 206 in `bad-content-type` | 2 |
| `test/fixtures/assets.ts`, `test/fixtures/images.ts` (new) | Real raster bytes, Range variants | 2 |
| `src/crawl/render/image-stand-in.ts` (new) | Stand-in SVG, srcset lookup script, image measurement script, classification | 3 |
| `src/crawl/render/renderer.ts` | Fulfil image requests; measure; `RenderResult.images` | 3 |
| `src/crawl/render/run-render.ts` | Supplies the `imageDimensions` lookup | 3 |
| `src/db/schema.ts`, migration | `pages.render_images`; then a11y columns + `render_a11y` | 3, 4 |
| `src/crawl/render/a11y.ts` (new) | The subset table, axe injection/run, result shaping | 4 |
| `src/api/config-schema.ts`, `src/crawl/loop.ts`, `src/crawl/render/render-link.ts` | `renderAccessibility` | 4 |
| `src/rules/query/render-console.ts` (new) | The 3 JS/request rules | 5 |
| `src/rules/query/render-images.ts` (new), `src/rules/metric/render-metrics.ts` | Image rule + metric | 6 |
| `src/rules/query/render-a11y.ts` (new) | 25 `a11y.*` rules + `render.not-recorded` | 7 |
| `src/rules/registry/*`, `issue-copy.ts`, `triage.ts`, `threshold*.ts` | Registration, copy, triage, threshold | 5–7 |
| `skills/ariadne-audit/checklist.md` | CHECK-49, 51, 83, new 89 | 5–7 |
| `test/fixtures/pages/authored-p29b.ts` (new), `test/fixtures/harness.test.ts` | Gate clauses 1 and 3 | 8 |
| `scripts/gate-rules.ts`, `docs/talos-*.md`, `docs/gates/phase-29b.md`, `CLAUDE.md` | Gate clause 2, surface docs | 9 |

---

### Task 1: Image header parser

**Files:**
- Create: `src/crawl/resources/image-size.ts`
- Test: `test/crawl/image-size.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const IMAGE_HEADER_BYTES = 65_536;
  export type ImageSize =
    | { kind: "size"; format: "png" | "jpeg" | "gif" | "webp" | "avif"; width: number; height: number }
    | { kind: "none"; reason: "svg" | "unknown-format" | "header-beyond-limit" | "malformed" | "empty" };
  export function readImageSize(head: Uint8Array, contentType: string | null): ImageSize;
  ```

Our own implementation; nothing is lifted (hard rule 8). It never decodes pixels.
- **PNG:** the IHDR at bytes 16–23.
- **GIF:** the logical screen at 6–9, little-endian.
- **JPEG:** walk the markers to the first SOF0–SOF15, excluding DHT (C4), JPG (C8) and DAC
  (CC). Height is at +5, width at +7.
- **WebP:** RIFF, then one of:
  - `VP8 `: 14-bit width/height at chunk+26/+28;
  - `VP8L`: 14-bit fields packed after the `0x2f` signature;
  - `VP8X`: 24-bit (width−1)/(height−1) at chunk+12/+15.
- **AVIF:** an ISOBMFF walk `ftyp` → `meta` (full box) → `iprp` → `ipco` → first `ispe`. It
  stays bounded by `head.length`.
- **SVG:** detected by content type `image/svg+xml` or a leading `<svg`/`<?xml`, and it is
  `none/svg`.
- A width or height of 0 is `malformed`.
- A JPEG or AVIF whose structure runs past `head.length` before a size is found is
  `header-beyond-limit`.

- [ ] **Step 1: Write the failing tests.**
  - One per format, built from hand-made byte headers (a helper writes big- and little-endian
    ints).
  - Assert exact `{kind:"size", width, height}`:
    - PNG 1600×1200;
    - JPEG with an APP1 segment before SOF2, 800×533;
    - GIF 1×1;
    - WebP VP8 640×480, VP8L 641×481, VP8X 4000×3000;
    - AVIF `ispe` 1920×1080.
  - Plus:
    - `readImageSize(svgBytes,"image/svg+xml")` → `{kind:"none",reason:"svg"}`;
    - 2 KB of `0x41` under `image/png` → `unknown-format`;
    - a JPEG whose 70 KB APP1 pushes SOF past 65,536 bytes, truncated to 65,536 →
      `header-beyond-limit`;
    - PNG IHDR with width 0 → `malformed`;
    - an empty array → `empty`.
  - A fuzz loop: 2,000 random buffers of 0–200 bytes, each beginning with a real signature,
    never throw and always return a `kind`.
- [ ] **Step 2:** `npx vitest run test/crawl/image-size.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `readImageSize`.
- [ ] **Step 4:** The tests pass, and `npx tsc --noEmit` is clean.
- [ ] **Step 5:** Commit `feat(resources): read intrinsic image size from the format header (29b)`.

### Task 2: The resource pass reads image headers with a Range GET

**Files:**
- Modify:
  - `src/crawl/resources/fetch-resources.ts` (the HEAD/GET loop ~613–860, `requestResource`
    ~1134, `Verdict`, `writeVerdict`, `WorkItem`);
  - `src/db/schema.ts` (`resources`);
  - `src/rules/query/resources.ts:472`;
  - `test/fixtures/assets.ts`.
- Create:
  - the migration (drizzle-kit);
  - `test/fixtures/images.ts`.
- Test:
  - `test/crawl/fetch-resources.test.ts`;
  - `test/rules/resources*.test.ts` (whichever holds `bad-content-type`).

**Interfaces:**
- Consumes: `readImageSize`, `IMAGE_HEADER_BYTES` (Task 1).
- Produces, on `resources` (nullable, null = not measured):
  - `width integer`;
  - `height integer`;
  - `dimensions_reason text`: the `ImageSize` `none` reason, or `not-image` for a 2xx whose
    content type is not `image/*`.
  - All three stay null on non-image kinds and on non-ok rows.
- Produces `test/fixtures/images.ts`:
  - `pngBytes(w,h): Buffer`, a real, decodable PNG built with `node:zlib`;
  - `jpegHeader(w,h): Buffer`;
  - `serveImage(req,res,{bytes, contentType, range: "honour"|"ignore"|"star"})`.

**Behaviour, for `kind = 'image'` only.** CSS and JS keep HEAD, unchanged.
- The first request is `GET` with `Range: bytes=0-65535`. Redirect hops are followed as
  today, each with the same Range header and each counted against `MAX_ROW_REQUESTS`.
- **`206` with `Content-Range: bytes a-b/N`** (N an integer):
  - `bytes = N`, `bytes_source = 'header'`;
  - the body is read (≤65,536 bytes) and passed to `readImageSize`.
- **`200`** (the server ignored Range):
  - the body is streamed into the counter as the counted GET does today
    (`bytes_source = 'counted'`, the `MAX_COUNTED_BYTES` cap and note unchanged);
  - the first 65,536 bytes are copied aside and parsed. No more than that is retained.
- **`206` with `/*`, or `416`:** one plain counted GET follows (R7), parsed as for `200`.
- **Any other non-ok status:** recorded exactly as today, with no dimensions.
- `status_code` stores the final status as answered (R8).
- **The request bound holds:** never more than 2 requests per image row plus its redirect
  hops.

- [ ] **Step 1: Write the failing tests** in `fetch-resources.test.ts`, against local servers
  built with `serveImage`:
  - `honour` PNG 1600×1200, 30,000 bytes → row `{fetch_class:'ok', status_code:206,
    bytes:30000, bytes_source:'header', width:1600, height:1200,
    dimensions_reason:null}`. The server saw exactly 1 request, method GET, `range:
    bytes=0-65535`.
  - `ignore` → `status_code:200, bytes_source:'counted'`, bytes = the body length, dimensions
    read, 1 request.
  - `star` → 2 requests (Range GET then plain GET), `bytes_source:'counted'`, dimensions
    read.
  - A `416` server → 2 requests, the row from the second answer.
  - An SVG asset → `width null, dimensions_reason:'svg'`, 1 request.
  - Garbage `image/png` → `unknown-format`.
  - A 70 KB-APP1 JPEG on `honour` → `header-beyond-limit`, bytes from Content-Range.
  - A CSS resource still sends exactly 1 HEAD.
  - `image/*` 404 → `client_error`, all three dimension columns null.
  - **Request parity (gate clause 3):** for each of the three server shapes, plus one that
    answers HEAD with no `content-length` and then GET, the number of requests the image URL
    received is ≤ what the HEAD path cost:
    - honour 1 (was 1);
    - ignore 1 (was 1);
    - HEAD-no-size server 1 (was 2).

    Assert the literal counts.
- [ ] **Step 2: Write the failing rule test.** A `kind='image'` row with `status_code 206`,
  `content_type text/html` and a page edge fires `resources.bad-content-type`.
- [ ] **Step 3:** Add the three columns to `resources` in `schema.ts` with the doc comments
  this file's style uses. Run `npx drizzle-kit generate`, then `npm run db:migrate`.
- [ ] **Step 4:** Implement the Range path. `WorkItem` gains `kind`, read by `workList`.
  `Verdict` gains `width`, `height` and `dimensionsReason`. Change `resources.ts:472` to
  `r.status_code in (200, 206)`.
- [ ] **Step 5: Fixture assets.** `assets.ts` gains real raster images (via
  `test/fixtures/images.ts`) at new paths, served with `range: "honour"`. Existing SVG and
  heavy-image assets are unchanged. Range is honoured on raster paths only.
- [ ] **Step 6:**
  - `npx vitest run test/crawl/fetch-resources.test.ts test/rules` passes.
  - Then the full `npm test`. Fixture-harness counts that read resource request totals may
    move: update them only where this task's change explains the move, and say so in the
    commit body.
- [ ] **Step 7:** Commit `feat(resources): image rows are asked with a 64 KiB Range GET and
  record intrinsic size (29b)`.

### Task 3: Renderer image stand-ins and measurement

**Files:**
- Create: `src/crawl/render/image-stand-in.ts`
- Modify:
  - `src/crawl/render/renderer.ts` (`RendererOptions`, `RenderTraffic.onPaused` ~990–1068,
    `RenderResult`, `render()`, `failure()`, `NO_TRAFFIC`, `writeRenderResult`, context
    options ~2026);
  - `src/crawl/render/run-render.ts` (renderer launch ~629);
  - `src/crawl/versions.ts`;
  - `src/db/schema.ts` (`pages`).
- Create: the migration.
- Test:
  - `test/crawl/renderer.test.ts`;
  - `test/crawl/image-stand-in.test.ts`.

**Interfaces:**
- Consumes: `resources.width/height/bytes` (Task 2); `normalizeUrl` from
  `src/crawl/parse/url-utils.ts`.
- Produces:
  ```ts
  // image-stand-in.ts
  export const MAX_RENDER_IMAGES = 1000;
  export const RENDER_IMAGES_KEPT = 50;
  export interface StoredImage { width: number; height: number; bytes: number | null }
  export type ImageDimensionLookup =
    (normalisedUrls: readonly string[]) => Promise<ReadonlyMap<string, StoredImage>>;
  export function standInSvg(width: number, height: number): string;
  // `<svg xmlns="http://www.w3.org/2000/svg" width="W" height="H"/>`
  export const SRCSET_LOOKUP_SCRIPT: string;   // (requestUrl) => {w: number|null, candidates: string[]} | null
  export const IMAGES_MEASURE_SCRIPT: string;  // () => {total, rows: [currentSrc, width, height, loading][]}
  export interface RenderImage {
    url: string; cut: boolean; intrinsicWidth: number; intrinsicHeight: number;
    displayedWidth: number; displayedHeight: number; wastedPixels: number;
    bytes: number | null; widthFrom: "stored" | "srcset-w";
  }
  export interface RenderImages {
    total: number; examined: number; measured: number; hidden: number;
    lazyUnloaded: number; notRequested: number; noDimensions: number;
    widerThanDisplayed: number; standIns: number; kept: RenderImage[];
  }
  export function classifyImages(
    measured: { total: number; rows: [string, number, number, string][] },
    served: ReadonlyMap<string, StoredImage & { widthFrom: RenderImage["widthFrom"] }>,
    requested: ReadonlySet<string>,
  ): RenderImages;
  // renderer.ts
  RendererOptions.imageDimensions: ImageDimensionLookup | null;   // required key (the `htmlDir` precedent)
  RenderResult.images: RenderImages | null;                       // null on every failed render
  // run-render.ts: a lookup over `resources` where crawl_id = this crawl and url = any($1)
  //   and width is not null, one query per call.
  ```
- `pages.render_images jsonb` (`RenderImages`). Null means not rendered, render failed, or
  rendered before capture 3.
- `RENDER_CAPTURE_VERSION = 3`, with its doc comment extended.

**Interception (`onPaused`).** The image branch runs BEFORE the cross-origin check.
1. For `resourceType === "Image"`, record the request URL (fragment stripped) in a per-render
   `requested` set.
2. Normalise the URL and call `imageDimensions`.
3. On a miss, evaluate `SRCSET_LOOKUP_SCRIPT` in the main frame (R6), then look up the
   siblings.
4. With a size:
   - `Fetch.fulfillRequest` with status 200, headers `content-type: image/svg+xml` and
     `cache-control: no-store`, and the body `standInSvg` base64;
   - record it in `served`;
   - `standIns += 1`;
   - no gate slot, no ledger entry, not counted as blocked or skipped.
5. Without a size, fall through to today's logic unchanged:
   - cross-origin → `blocked`;
   - same-origin paint-only → `skipped`.
6. A lookup that rejects is our defect: it reaches `guard`, and the render throws.

`Media` and `Font` are untouched.

**Measurement.**
- **Phase 1:** after `MEASURE_SCRIPT`, evaluate `IMAGES_MEASURE_SCRIPT` with the first
  `MAX_RENDER_IMAGES` `img` elements in document order. `currentSrc` has its fragment
  stripped. Width and height come from `getBoundingClientRect` and are `Math.round`ed.
- **Classification, in this order:**
  1. a box under 1×1 → `hidden`;
  2. `currentSrc` not in `requested` → `lazyUnloaded` if `loading === "lazy"`, else
     `notRequested`;
  3. in `served` → `measured`;
  4. otherwise → `noDimensions`.
- For a measured image, `wastedPixels = max(0, iW·iH − dW·dH)`, and
  `widerThanDisplayed` counts `iW > dW`.
- `kept` holds those images sorted by `wastedPixels` desc, then bytes desc, then url, and
  sliced to 50.
- URLs go through `storableText(url, RENDER_CONSOLE_MAX_CHARS)`.

- [ ] **Step 1: Write the failing unit tests** (`image-stand-in.test.ts`):
  - `standInSvg(1600,1200)` gives the exact string.
  - `classifyImages` over a hand-built input:
    - 1 hidden;
    - 1 lazy unrequested;
    - 1 `notRequested` (no `loading`);
    - 1 requested-not-served;
    - 3 measured at intrinsic/displayed widths 1600/400, 800/800 and 1000/600.

    Expect `measured 3`, `widerThanDisplayed 2`, and `kept` ordered by wasted pixels, the
    1600/400 image first.
  - 60 wider images → `kept.length 50`.
- [ ] **Step 2: Write the failing browser tests** (`renderer.test.ts`). These use a real
  Chromium, a local origin server and a second local "CDN" server, each counting the requests
  it receives by path. Each case asserts `result.images`:
  - (a) same-origin `<img src=/big.png style="width:400px">` with stored 1600×1200 →
    measured, `kept[0]` `{intrinsicWidth:1600, displayedWidth:400}`, and the origin received
    0 requests for `/big.png`;
  - (b) a CDN `<img>` with stored dimensions → measured, CDN request count 0;
  - (c) a CDN `<script>` → still failed (CDN count stays 0), and `blockedByRenderer.thirdParty`
    ≥ 1;
  - (d) `<img srcset="a-400.png 400w, a-1600.png 1600w" sizes="100vw"
    style="width:300px">`, where only `a-400.png` is stored (400×300). The browser picks
    1600w at a 1280-wide viewport → measured, `{intrinsicWidth:1600, intrinsicHeight:1200,
    widthFrom:"srcset-w"}`;
  - (e) `<img loading=lazy>` at `top:5000px` → `lazyUnloaded 1`;
  - (f) a `display:none` parent → `hidden 1`;
  - (g) an image with no stored dimensions → `noDimensions 1`, and
    `blockedByRenderer.sameOriginAssets` counts it;
  - (h) **cache**: render page P1 (stand-in for `/big.png`), then on the same worker context
    render P2, which `fetch('/big.png')`es via script. The origin receives the real request
    (paced), proving the stand-in was not served from cache;
  - (i) `imageDimensions: null` → every image `noDimensions`, behaviour identical to today.
  - Failed renders carry `images: null`.
- [ ] **Step 3:** Run them; they FAIL.
- [ ] **Step 4:** Add `pages.render_images`. Run `npx drizzle-kit generate`, then
  `npm run db:migrate`.
- [ ] **Step 5:** Implement as above.
  - Set `deviceScaleFactor: 1` beside the viewport.
  - `writeRenderResult` writes `render_images` (JSON, via `storableDeep`).
  - Bump `RENDER_CAPTURE_VERSION` to 3, updating the comment.
  - `run-render.ts` builds the lookup with `crawlId` closed over.
  - Every other `PageRenderer.launch` caller passes `imageDimensions` explicitly.
- [ ] **Step 6:** The tests pass; then `npm test` and `npx tsc --noEmit`.
- [ ] **Step 7:** Commit `feat(render): answer image requests with true-size SVG stand-ins and
  measure each <img> (29b)`.

### Task 4: Accessibility run (axe-core) and `renderAccessibility`

**Files:**
- Create: `src/crawl/render/a11y.ts`
- Modify:
  - `package.json` / `package-lock.json`;
  - `THIRD_PARTY_NOTICES.md`;
  - `src/crawl/render/renderer.ts`;
  - `src/crawl/render/run-render.ts`;
  - `src/crawl/render/render-link.ts`;
  - `src/crawl/loop.ts` (`CrawlConfig`, config reading ~1217);
  - `src/api/config-schema.ts`;
  - `src/api/mcp.ts` (the config-key lists ~549, ~1206);
  - `src/db/schema.ts`.
- Create: the migration.
- Test:
  - `test/crawl/renderer.test.ts`;
  - `test/crawl/a11y.test.ts`;
  - the config-schema test.

**Interfaces:**
- Produces:
  ```ts
  // a11y.ts
  export const AXE_TIMEOUT_MS = 30_000;
  export const A11Y_TARGETS_MAX = 5;
  export const A11Y_TARGET_CHARS = 200;
  export interface A11yRuleRow { axeId: string; group: string; severity: "warning" | "info"; wcag: "A" | "AA" }
  export const A11Y_RULES: readonly A11yRuleRow[];
  export interface A11yViolation { rule: string; impact: string | null; nodeCount: number; targets: string[] }
  export interface RenderA11y {
    status: "ran" | "disabled" | "timeout" | "interrupted";
    ms: number | null;
    violations: A11yViolation[];
  }
  export function axeSource(): string;   // readFileSync of axe-core/axe.min.js, read once and memoised
  export function shapeAxeResults(raw: unknown): A11yViolation[];   // throws on a shape it does not know
  // renderer.ts
  RendererOptions.accessibility: boolean;   // required
  RenderResult.a11y: RenderA11y | null;     // null on a failed render
  RenderTestFaults.axeTimeoutMs?: number;   // TEST ONLY, overrides AXE_TIMEOUT_MS
  // config
  CrawlConfig.renderAccessibility?: boolean;  // default true; config-schema `mutable: "whenPaused"`
  ```
- `A11Y_RULES` is exactly these 25, in this order, with severity from axe 4.14.0's declared
  impact: critical or serious → `warning`, moderate or minor → `info`.

  | Group | axe id (severity, level) |
  |---|---|
  | Text alternatives | `image-alt` (warning, A), `input-image-alt` (warning, A), `role-img-alt` (warning, A), `area-alt` (warning, A), `object-alt` (warning, A) |
  | Names | `link-name` (warning, A), `button-name` (warning, A), `input-button-name` (warning, A), `select-name` (warning, A), `label` (warning, A), `frame-title` (warning, A) |
  | Language | `document-title` (warning, A), `html-has-lang` (warning, A), `html-lang-valid` (warning, A), `valid-lang` (warning, AA) |
  | Behaviour | `meta-viewport` (info, AA), `meta-refresh` (warning, A) |
  | ARIA | `aria-hidden-focus` (warning, A), `aria-required-attr` (warning, A), `aria-valid-attr` (warning, A), `aria-valid-attr-value` (warning, A), `duplicate-id-aria` (warning, A) |
  | Structure | `list` (warning, A), `listitem` (warning, A) |
  | Contrast | `color-contrast` (warning, AA) |

- **Storage:**
  - `pages.render_a11y_status text` and `pages.render_a11y_ms integer` (R3);
  - table `render_a11y` with these columns:
    - `crawl_id` (FK `crawls.id`, on delete cascade);
    - `page_id text`;
    - `axe_rule text`;
    - `impact text`;
    - `node_count integer not null`;
    - `targets jsonb not null` (string[]).
  - Unique `(crawl_id, page_id, axe_rule)`; index `(crawl_id, axe_rule)`.
  - No HTML snippet is stored.

**Run.** It happens after phase 2's `page.content()` and `analyzeHtml`, and only when
`accessibility` is true (otherwise `{status:"disabled", ms:null, violations:[]}`).
1. Evaluate `axeSource()`.
2. Call `axe.run(document, { runOnly: {type:"rule", values: A11Y_RULES ids}, resultTypes:
   ["violations"], iframes: false, elementRef: false, selectors: true, ancestry: false,
   xpath: false })`, raced against `AXE_TIMEOUT_MS`.
3. On timeout: `Runtime.terminateExecution` → `timeout`.
4. "Execution context was destroyed" or a closed target → `interrupted`.
5. Any other error is thrown (our defect; it stops the pass).

`ms` is wall time around the run. For targets, a selector array (shadow DOM path) is joined
with ` >>> `. The first 5 are kept, each through `storableText(…, 200)`. Violations come from
`violations` only.

**Writer.** In the same statement batch as the page update: delete the `render_a11y` rows for
(crawl, page id from `returning id`), then insert this render's rows. A re-render replaces
them.

- [ ] **Step 1:** `npm install --save-exact axe-core@4.14.0`.
  - Add the `THIRD_PARTY_NOTICES.md` entry: MPL-2.0, unmodified, source URL, the bundled MIT
    components named.
  - A test asserts `require("axe-core/package.json").version === "4.14.0"`, and that every
    `A11Y_RULES` id is in `axe.getRules()` run in a page.
- [ ] **Step 2: Write the failing tests.**
  - `a11y.test.ts`: `shapeAxeResults` on a recorded axe result object, covering the target
    cap and cut, and the shadow join. It throws on a non-array `violations`.
  - `renderer.test.ts`, each asserting `result.a11y`:
    - a page with one `<img>` without alt and a `<html>` without lang →
      `status:"ran"`, violations exactly `image-alt` and `html-has-lang`, each with
      `nodeCount: 1`;
    - a clean page → `ran`, `[]`;
    - `accessibility:false` → `disabled`;
    - a page that starts `while(true){}` 4 s after load (after settle) → `timeout`, while
      `wordCount` and `images` are still set and the render is `rendered:true`.
      - Run this case with a test override of the timeout, via `RenderTestFaults.axeTimeoutMs`.
    - a page whose script navigates on a timer that fires during axe → `interrupted`.
- [ ] **Step 3:** Run them; they FAIL.
- [ ] **Step 4:** Add the migration (drizzle-kit generate, then migrate).
- [ ] **Step 5:** Implement the run and the writer.
  - Plumb `renderAccessibility`: config-schema entry (boolean, default true,
    `mutable: "whenPaused"`, a description in the house style); `CrawlConfig`; render-link
    → `RenderPassConfig.renderAccessibility` → `RendererOptions.accessibility`.
  - Update the mcp.ts key lists.
  - `writeRenderResult` writes `render_a11y_status`, `render_a11y_ms` and the rows.
- [ ] **Step 6:** The tests pass; then `npm test` and `npx tsc --noEmit`. The config-schema
  snapshot and OpenAPI tests update to carry the new key.
- [ ] **Step 7:** Commit `feat(render): run a pinned axe-core WCAG A/AA subset on each rendered
  page (29b)`.

### Task 5: JavaScript error and failed-request rules (CHECK-51)

**Files:**
- Create: `src/rules/query/render-console.ts`
- Modify:
  - `src/rules/index.ts`;
  - `src/rules/registry/registry.ts` (`RULESET_VERSION` `0.27.0`, changelog entry
    `// 0.27.0: Phase 29b …`, items appended by Tasks 6–7);
  - `src/rules/registry/copy/issue-copy.ts`;
  - `src/rules/registry/triage.ts`;
  - `skills/ariadne-audit/checklist.md` (CHECK-51).
- Test: `test/rules/render-console.test.ts`

**Interfaces:**
- Consumes: `pages.render_console` (`RenderConsole`, console-capture.ts).
- Produces these rules:
  - `render.js-exception` (warning; triage `warning`/`medium`): `exceptionsTotal > 0`;
  - `render.console-error` (info; `warning`/`low`): any `console[]` entry at level `error`,
    or `consoleTotal > 0` with an error level among the kept entries. Warnings alone do not
    fire.
  - `render.failed-request` (warning; `issue`/`medium`): `failedRequestsTotal > 0`.
- All three:
  - claim `CHECK-51`, category `technical`;
  - have one finding per page where `render_console is not null`. This includes failed
    renders, because errors before a timeout are the point.
- Evidence fields:
  - `template` (`page_type`);
  - `rendered` (bool);
  - the kept entries (≤20) and the total;
  - `blockedByRenderer` (on the two console rules).
- Columns label the totals and the first entry.

- [ ] **Step 1: Write the failing tests.** Insert synthetic page rows with `render_console`
  JSON:
  - an exception → only `render.js-exception`, with `exceptionsTotal`, `template` and
    `blockedByRenderer` in the evidence;
  - one error-level console entry → `render.console-error`;
  - warnings only → nothing;
  - a failed request `{status:404, reason:"http 404"}` → `render.failed-request`;
  - a `rendered = false` row with a captured exception → still fires;
  - `render_console` null → nothing.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement**, following `render-diff.ts`'s `defineRule<QueryRule>` pattern.
  - Copy: each explanation says the finding comes from the rendered sample and names the
    template column.
  - The two console rules' copy says that blocked third-party requests
    (`blockedByRenderer`) can cause errors such as an undefined analytics global, and tells
    the agent to confirm such an error on the live page before reporting it.
  - `render.failed-request`'s copy says the site's own scripts, CSS, XHR and fetch are
    covered, and third-party failures are not measured.
- [ ] **Step 4: Rewrite CHECK-51**, replacing the "NOT MEASURED whatever the crawl" text.
  - Name the three rules, their severities and what they measure, keeping the
    `resources.broken` half.
  - Third-party failures are not measured.
  - The sample caveat.
  - `render.not-recorded` is named here once Task 7 adds it, so leave a placeholder for it.
- [ ] **Step 5:** `npm test` (the registry, copy, triage, checklist-severity and
  identifier-guard tests included) and `npx tsc --noEmit`.
- [ ] **Step 6:** Commit `feat(rules): JavaScript exceptions, console errors and failed
  requests from the render pass (29b, CHECK-51)`.

### Task 6: `images.larger-than-displayed` and its metric (CHECK-49)

**Files:**
- Create: `src/rules/query/render-images.ts`
- Modify:
  - `src/rules/thresholds.ts`;
  - `src/rules/threshold-table.ts`;
  - `src/rules/metric/render-metrics.ts`;
  - `src/rules/index.ts`;
  - the copy and triage tables;
  - `registry.ts` changelog;
  - `checklist.md` (CHECK-49).
- Test: `test/rules/render-images.test.ts`

**Interfaces:**
- Consumes: `pages.render_images` (`RenderImages`, Task 3).
- Produces:
  - **The threshold.** `IMAGE_OVERSIZE_PERCENT` (default 200; row `{min:101, max:1000}`),
    read through `judgementOr(ctx).thresholds`.
  - **The rule.** `images.larger-than-displayed` (warning; `opportunity`/`medium`; category
    `technical`; CHECK-49).
    - Scope: one finding per rendered page with `render_version >= 3`, where some `kept`
      image has `intrinsicWidth * 100 > IMAGE_OVERSIZE_PERCENT * displayedWidth` and
      `displayedWidth >= 1`.
    - Evidence:
      - `template`;
      - `oversizedCount`, the count among `kept`;
      - `atLeast: widerThanDisplayed > kept.length`;
      - `images`, the ≤20 matching images in `kept` order;
      - `measured`;
      - `measuredShare`, which is `measured / (measured + noDimensions)`, or null when that
        is 0.
    - Copy uses `{IMAGE_OVERSIZE_PERCENT}`.
  - **The metric.** `render.image-measurement` (metric, CHECK-49), crawl-level and per
    template: sums of `total`, `measured`, `hidden`, `lazyUnloaded`, `notRequested`,
    `noDimensions` and `standIns` over capture-3 rendered pages, plus `measuredShare`.

- [ ] **Step 1: Write the failing tests.** Synthetic rows:
  - 1600/400 fires and 800/800 does not.
  - 450/200 (225%) fires at the default and not at an override of 250.
  - `kept` truncated → `atLeast: true`.
  - `render_version 2` → silent.
  - The metric sums over two templates.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** The rule is SQL over `jsonb_array_elements(render_images->'kept')`,
  so nothing is loaded crawl-wide.
- [ ] **Step 4: Update CHECK-49.**
  - Add the rule and the metric.
  - Explain that the 2× default allows for high-density screens, and how to override it.
  - Lazy and hidden images are counted, not measured.
  - The fixed 1280×900 desktop viewport.
- [ ] **Step 5:** `npm test`, then `npx tsc --noEmit`. The threshold-table tests and
  threshold-guard tests must cover the new row.
- [ ] **Step 6:** Commit `feat(rules): images served wider than displayed, from the render pass
  (29b, CHECK-49)`.

### Task 7: Accessibility rules, CHECK-89, and `render.not-recorded`

**Files:**
- Create: `src/rules/query/render-a11y.ts`
- Modify:
  - `src/rules/registry/types.ts` (`RuleCategory` gains `"accessibility"`);
  - `registry.ts` (`CRAWL_CHECK_IDS` gains `"CHECK-89"`; changelog);
  - `src/rules/index.ts`;
  - copy and triage;
  - `checklist.md` (new CHECK-89 entry; CHECK-83 NOT MEASURED list; CHECK-49 and CHECK-51
    name the marker);
  - `test/rules/coverage.test.ts` (header prose only; the pin stays `[]`).
- Test: `test/rules/render-a11y.test.ts`

**Interfaces:**
- Consumes: `A11Y_RULES` (Task 4); `render_a11y`; `pages.render_a11y_status`,
  `render_version`, `render_console`.
- Produces:
  - **25 rules `a11y.<axeId>`**, generated by mapping `A11Y_RULES` through
    `defineRule<QueryRule>`.
    - Severity from the table; triage `issue`/`low`; category `accessibility`; checkIds
      `["CHECK-89"]`.
    - One finding per page with a `render_a11y` row for that rule, on pages where
      `render_a11y_status = 'ran'`.
    - Evidence: `template`, `impact`, `nodeCount`, `targets`, `wcag`.
  - **The marker `render.not-recorded`** (info; `marker:` set; triage `warning`/`low`;
    checkIds `CHECK-49`, `CHECK-51`, `CHECK-89`).
    - One crawl-level finding when any of these is > 0 among `rendered = true` pages:
      - `consoleNotCaptured` (`render_console is null`);
      - `capturedBeforeImagesAndA11y` (`render_version is null or < 3`);
      - `accessibilityDisabled`;
      - `accessibilityIncomplete` (`timeout` + `interrupted`).
    - Evidence: those four counts, plus `renderedPages` and `families` (the names not
      measured).
    - Silent on a crawl with no rendered page (R4).

- [ ] **Step 1: Write the failing tests.**
  - A `ran` page with an `image-alt` row → exactly `a11y.image-alt`, with evidence.
  - A `disabled` page with a stale row → nothing.
  - `meta-viewport` → severity `info`.
  - The registry holds 25 `a11y.` rules, and their ids equal `A11Y_RULES` exactly.
  - The marker fires on each of the four conditions and is silent on a fully capture-3,
    `ran` crawl, and on a crawl with no rendered pages.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement the rules and copy.**
  - Each `a11y.*` title reads `Accessibility: <plain description>`.
  - The explanation names the WCAG level and states the sample.
  - The fix says what to change in the template.
  - Copy may describe the success criterion, but must not quote axe's own help text verbatim.
- [ ] **Step 4: Checklist.**
  - Add `### CHECK-89: Accessibility — WCAG A/AA subset (rendered sample)` with every rule id
    and severity.
  - Add the marker to CHECK-83's list and to CHECK-49/51/89.
  - Fill Task 5's placeholder.
- [ ] **Step 5:** `npm test`, then `npx tsc --noEmit`.
  - The coverage pin stays `[]`, because CHECK-89 is claimed.
  - The checklist-severity, identifier-guard and copy tests must pass without exceptions
    added.
- [ ] **Step 6:** Commit `feat(rules): WCAG A/AA accessibility subset and the render
  not-recorded marker (29b, CHECK-89)`.

### Task 8: Fixture site and harness (gate clauses 1 and 3)

**Files:**
- Create: `test/fixtures/pages/authored-p29b.ts`
- Modify:
  - `test/fixtures/fixture.ts` (register);
  - `test/fixtures/app.ts`/`assets.ts` (any new asset paths);
  - `test/fixtures/harness.test.ts`;
  - existing fixture expectations where a11y facts are true.

**Interfaces:**
- Consumes: everything above; `Fixture`, `renderDocument` and the control recipe.

**Pages, all `exact: true`, built from the control recipe:**
- `/p29b/js-exception`: inline script `throw new Error("fixture")` after load →
  `render.js-exception`.
- `/p29b/failing-script`: `<script src="/p29b/missing.js">`, which 404s →
  `render.failed-request`.
- `/p29b/image-4x`: a raster 1600×1200 at `width:400px` → `images.larger-than-displayed`.
- `/p29b/image-1x`: 400×300 at 400px → nothing.
- `/p29b/srcset`: the Task 3 (d) shape → fires.
- `/p29b/cdn-image`: an asset-host raster at 4× → fires. Gives the asset host a raster path
  with Range honoured.
- `/p29b/lazy`: an oversized `loading=lazy` image at `margin-top:5000px` → nothing (counted
  `lazyUnloaded`).
- `/p29b/a11y/<axe-id>`: 25 pages generated from `A11Y_RULES`, each carrying exactly one
  violation of its rule → `a11y.<axe-id>`.
  - A violation that necessarily trips an existing rule has that rule in its expectations.
    The obvious ones:
    - `document-title` → the missing-title rule;
    - `html-has-lang` → the missing-lang rule;
    - `image-alt` → the missing-alt rule;
    - `meta-refresh` → the refresh rule.
  - Each such pairing gets a one-line comment.

**Harness.**
- The harness's existing render step renders these pages.
- Every page that ran into Range must receive exactly one image request from the resource
  pass. The proof uses the asset counters (`app.ts` request log), with literal counts.
- Record `measuredShare` across the `/p29b/` image pages for the gate document.

**Existing fixtures.**
- Run the harness. For every new `a11y.*` or `render.*` finding on an existing `exact`
  fixture or on `/control`, confirm by reading the page that the violation is real.
  - Then either add it to that fixture's expectations, with a comment, or, if the fixture is
    not about it and the violation is incidental (for example an icon link without a name in
    shared chrome), fix the fixture markup so the page tests only what its name promises.
  - Never drop an axe rule to quiet a fixture.
- `/control` must stay finding-free.

- [ ] **Step 1:** Write the fixture pages and harness assertions (the floor of the gate);
  they FAIL until wired.
- [ ] **Step 2:** Register the pages and add the assets; run
  `npx vitest run test/fixtures/harness.test.ts`.
- [ ] **Step 3:** Reconcile the existing fixtures as above, and list each change in the commit
  body.
- [ ] **Step 4:** `npm test` green, `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `test(fixtures): Phase 29b render-check pages and harness gate (29b)`.

### Task 9: Gate tooling, surface docs, gate run

**Files:**
- Modify:
  - `scripts/gate-rules.ts`;
  - `docs/talos-surface.md`;
  - `docs/talos-integration.md`;
  - `CLAUDE.md` ("Phases 0–29b are shipped" after the gate);
  - `docs/crawl-audit-build-plan.md` if it lists shipped phases.
- Create: `docs/gates/phase-29b.md`.

- [ ] **Step 1: `gate-rules.ts`.**
  - After the render phase, report the render pass duration (already there).
  - Report the axe time over `pages.render_a11y_ms` with `percentile_cont(0.5)` and
    `percentile_cont(0.95)`.
  - Report the counts of `render_a11y_status` by value.
  - All of these go into the `--json-out` artifact. They are recorded, not gated.
  - Process peak RSS stays gated as today.
- [ ] **Step 2: Surface docs.**
  - New rules and the marker.
  - `renderAccessibility` (whenPaused).
  - `pages.render_images` and the `render_a11y` evidence shapes.
  - The Range GET's effect on `resources.status_code` (206) and the three new columns.
  - Stand-ins as the fence's one answered exception.
- [ ] **Step 3:** `npm test` and `npx tsc --noEmit`; commit
  `docs: Phase 29b surface, checklist and gate tooling (29b)`.
- [ ] **Step 4 (the controller runs this; it needs the owner's OK for a new DB): the gate.**
  - Create `ariadne_gate29b` and run the 50k gate with the render pass.
  - Record crawl, render and rules peaks against the bound (local ≤ 290.2 MB, hard 512 MB),
    the render duration, and the axe median/p95.
  - Confirm the 50k site's `notFound` count is unmoved against Phase 28c's figure.
  - Record the fixture clauses (1 and 3) from Task 8 in `docs/gates/phase-29b.md`, with the
    measured-image share.
  - Commit `docs: Phase 29b gate`.

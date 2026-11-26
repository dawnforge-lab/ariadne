# Phase 29d — Clearing the Phase 29 backlog

Date: 2026-11-24. Predecessor gate: Phase 29c (`docs/gates/phase-29c.md`, merged in PR #34,
`14af5b5`), plus the 29c follow-ups (PR #35, `12e832e`).

Status: design, awaiting owner review. Owner direction (2026-11-23): "let's do the 29
follow-on", then "they're all important, let's skip the questions". The scope is the open items
in the three Phase 29 gate docs, plus two older ones (PDF hreflang and user-agent presets). The
calls I made are listed at the end for the owner to check.

## Intent

Phase 29 shipped three waves of checks. Each gate doc ended with things that are true to the
data but wrong for a reader, or that hold only on a good day:

- **False findings a reader will act on.** Blog pagination (`/blog/10/`) is grouped with the
  posts, so `schema.template-inconsistent` flags 16 listing pages on lavishalice.com (29a §2.5).
- **Findings that never appear.** A page whose only unresolved `@id` reference is the 51st in a
  block gets no `schema.unresolved-reference` finding at all. The SQL filter only sees the
  first 50 stored references.
- **Facts dropped without a count.** Microdata keeps one `itemtype` token, RDFa one `typeof`.
  Blocks past the 50-block page cap and JSON-LD nodes past the depth cap disappear, and nothing
  counts them.
- **Half-judged hreflang.** A PDF's `Link` header alternates are stored and count as return
  links for other pages, but the PDF's own set is never judged (26c R16, deferred in 27d).
- **A crawl identity that cannot be chosen.** The owner wants Screaming Frog-style user-agent
  presets. Today one `userAgent` string feeds the request header and robots matching.
  robots-parser keys on the text before the first `/`, so a browser-style string matches as
  "mozilla" and falls silently to the `*` group.
- **Image sizes we could know.** About 0.5% of web-logo PNGs carry more than 64 KiB before
  IDAT. They are reported `header-beyond-limit` today, even when the image is square and
  orientation cannot change its size.
- **A render pass a hostile page can stop.** `MEASURE_SCRIPT` runs in the page's main world. A
  page that overrides a built-in can make it throw or return garbage. A non-integer then fails
  the write and stops the whole pass. No page has an overall deadline.
- **Thin margins.** Link derivation runs 51.7 s against its 60 s budget at 50k pages, and click
  depth takes another 46 s. `simhash64` makes about 11.5 MB of garbage per analysed page.
- **A leaky test.** Two worker processes started by `test/worker/serve.test.ts` were still
  polling the dev database five days later.

Success:
- lavishalice.com's pagination pages are no longer flagged;
- every unresolved reference is found, whatever its position;
- every dropped fact is counted;
- a PDF's hreflang set is judged like a page's;
- a crawl can run as Googlebot or Bingbot and honour that bot's robots group;
- a hostile page costs one page, never the pass;
- link derivation has comfortable room under its budget;
- the suite leaves no process behind.

## Goals

### 1. Pagination is its own page type

Today (`src/crawl/page-type.ts`):
- `detectUrlTemplate` turns an all-digit segment into `:id`.
- `inferPageTemplates` gives `/blog/:id` the family `/blog/:slug`.
- A family with at least two member types and three paths collapses into its slug type, so
  `/blog/10/` becomes `/blog/:slug`.

New rule:
- **A type whose last segment is `:id` no longer joins the `:slug` family beside it.**
  `/blog/:id` stays `/blog/:id`. The numeric pages form their own bucket, which
  `schema.template-inconsistent` judges on its own.
- Nothing else about inference changes:
  - `/blog/page/:id` was already separate.
  - A lone `/blog/:id` already keeps its name (test at `page-templates.test.ts:196`).
  - The harness template `/authored29a/tpl/:id` is all-numeric, so it is unaffected.
- The SQL statement and its JS oracle (`collapseTemplates`) change together. The parity test
  pins them.
- **The cost:** a site that mixes numeric and slug detail pages under one prefix
  (`/product/123` beside `/product/red-shirt`) now gets two page types where it had one. That
  can make a bucket miss `SCHEMA_TEMPLATE_MIN_PAGES`, which means a finding is missed, never a
  false one. I chose that over trying to read pagination from `rel=next`, which most sites no
  longer emit.
- **Ruleset bump**, because page types feed cohorts and findings. No extraction bump:
  inference runs at crawl close, and the rules re-derive nothing here, so old crawls keep the
  page types they were closed with. A re-crawl picks up the new rule.

### 2. Extraction 5: every type token, every dropped item counted

`EXTRACTION_VERSION` 4 → 5.

- **Microdata `itemtype` and RDFa `typeof` keep every token.**
  - `@type` is stored as an array when there is more than one, and stays a string when there is
    one. The validator already handles arrays (`schema-validate.test.ts:714`).
  - `structured_data.schema_type` keeps the first token, as JSON-LD does.
  - RDFa: an element with a schema.org token and a non-schema.org token keeps the schema.org
    ones. Today it is counted in `rdfaUnsupported` and dropped whole. It stays counted when it
    has no schema.org token.
- **Blocks past the 50-block cap are counted:** `structured_data_skips.blocksDropped`.
- **JSON-LD nodes past the depth cap (`MAX_LD_JSON_DEPTH = 5`) are counted:**
  `structured_data_skips.nodesDropped`.
- **Where these show:**
  - Listings: the read-time `blocksAtCap` guess gives way to the stored `blocksDropped` on
    extraction-5 pages.
  - The `structured_data` listing, MCP tool and CSV gain `blocksDropped` and `nodesDropped`.
  - Pages below extraction 5 keep today's `blocksAtCap` and report the two counts as not
    measured. They never report 0.
- No migration: `structured_data_skips` is jsonb. Its zod shape and the persist test grow.

### 3. Unresolved references are found wherever they sit

Today:
- `validate.ts` stores up to 50 references per block, resolved or not.
- `schema.unresolved-reference` pre-filters in SQL on that stored list, so a 51st reference that
  does not resolve is invisible.

New:
- The validator records the **unresolved references themselves**: up to 50, with an exact
  `unresolvedCount`.
- The SQL pre-filter selects on `unresolvedCount > 0`.
- The evidence lists the unresolved ones. It sets `problemsCapped` only when more than 50 are
  unresolved.
- This is computed at rules time (`deriveSchemaValidation` rewrites `validation_jsonb` on every
  run), so a ruleset bump and a rules re-run apply it to old crawls. No re-crawl and no
  extraction bump.
- The stale-blob shape check (`blob-sql.ts`) and the zod `blockValidationSchema` take the new
  field, so a blob written by 0.28.x is detected as stale and rewritten, never misread.

### 4. A PDF's hreflang set is judged (26c R16)

Today:
- `Link` header alternates on any classified response are stored in `hreflang` with
  `source = 'header'`, and they count as return links for other pages.
- The rules judge only `FETCHED_OK` (`fetch_class = 'ok'`) or auditable declarers, so a
  `non_html` 200 is never judged.

New:
- **A declarer is any 200 response with stored `header` or `html` declarations.** That covers
  `ok` and `non_html` alike. The return-link, invalid-code, non-indexable-target and
  not-crawled rules judge its set like a page's.
- **A PDF is indexable unless its HTTP headers say otherwise** (owner, 2026-11-24).
  - `pages.is_indexable` is true for a PDF (`content_type` `application/pdf`) that answers 200
    with no `noindex` (or `none`) in `X-Robots-Tag`. The same `saysNoindex` definition the HTML
    pages use decides it.
  - A `Link` canonical does not change it. That is the same as HTML, whose `is_indexable` does
    not read the canonical either.
  - Today `isIndexable` (`src/crawl/persist.ts:1062`) requires `fetch_class = 'ok'`, so every
    PDF is stored non-indexable. That changes at persist for new crawls. A data migration
    rewrites stored crawls from their stored status and `x_robots_tag`. Both facts have been
    stored since 26c.
  - Every reader of `is_indexable` (77 references in 19 files) is checked:
    - **Readers that mean an indexable document** take PDFs: sitemap, hreflang, link targets,
      the health counts and the diff.
    - **Readers that mean an indexable HTML page** gain an explicit `FETCHED_OK` guard: content
      and duplicate checks, render selection, the page-level indexability and canonical rules.
    - Owner ruling 2026-11-25: `site.health`, `links.orphan` and `structure.deep-page` are
      document readers too ("Let's include pdfs in health checks, orphan, deep"). This
      replaces an earlier decision that kept the three HTML-only. `site.health` gains
      `urlsPdf` ("Of Which PDFs"); `links.only-from-non-indexable` and
      `links.anchors-generic-only` stay HTML-only.
  - Other non-HTML types (Word, Excel, images) stay non-indexable.
- The cluster rules (`hreflang-integrity`, completeness) use the same declarer predicate. There
  is one definition, in `src/rules/helpers.ts`, beside `FETCHED_OK`.

### 5. User-agent presets with their own robots token

- **New crawl config `robotsUserAgent`:** the product token robots.txt is matched against
  (`AriadneBot`, `Googlebot`, `bingbot`).
  - It must be a single token: letters, digits, `-` and `_`, with no `/` and no spaces.
  - It feeds every robots read: discovery, the resources pass's other-host robots, `getCrawlDelay`,
    and the robots rule (`rules/query/robots.ts`).
  - The `userAgent` string stays the request header for pages, probe, discovery, resources,
    recheck and the renderer.
- **New crawl config `userAgentPreset`:** one of `ariadne` (the default), `googlebot-smartphone`,
  `googlebot-desktop` or `bingbot`.
  - A preset sets both `userAgent` and `robotsUserAgent` to the bot's published values. The
    strings are copied from Google's and Bing's crawler documentation, with the date read, into
    one table in `src/crawl/user-agents.ts`.
  - A preset together with an explicit `userAgent` or `robotsUserAgent` is a 400 naming both.
- **A custom `userAgent` without `robotsUserAgent`:**
  - The token is derived from the leading product token (the text before the first `/`) and
    stored in the config, so it is visible in `crawl_get` and in the robots evidence.
  - If that token is `Mozilla`, the start is a **400**: "userAgent starts with Mozilla/; robots
    rules would be matched as 'mozilla'. Set robotsUserAgent." It is never a silent fall to `*`.
- **Old crawls** have no stored `robotsUserAgent`. The robots rule reads them as they were
  actually crawled: the full `userAgent` string, through robots-parser. That is the record of
  what happened, not a fallback.
- Both fields are `mutable: "never"`, like `userAgent`.
- `docs/talos-surface.md`, the MCP descriptions and the skill note the limit: **a spoofed bot
  identity fails any site that verifies bots by IP or reverse DNS** (Cloudflare, most CDNs). A
  preset only helps on sites that filter by user-agent alone. It never bypasses a challenge.
- Hard rule 9 ("branded UA") stays the default. A preset is an explicit per-crawl choice the
  owner asked for (2026-11-16).

### 6. Image headers past 64 KiB

- **Square PNGs are reported losslessly.** When the walk reaches the window's end before IDAT
  without an `eXIf`, and the IHDR width equals its height, the IHDR size is the answer: no
  rotation can change it.
- **One continuation read (PNG and JPEG).**
  - The parsers gain a third answer besides a size and a reason: "need the bytes at offset N".
    For PNG that is the next chunk header (each chunk's length lets the walk hop over its body).
    For JPEG it is the next segment marker.
  - The resource pass then sends one more `Range` request for 64 KiB at that offset, through
    the same `admit` → `gate.acquire` → `reportToGate` path as every request.
  - **At most 2 continuation reads per image.** If the answer is still not found,
    `header-beyond-limit` stands. A host that answers a range request with a 200 gets no
    continuation, because the window was already copied from the full body.
  - The module header's promise "at most 2 requests plus its redirect hops" becomes 4, and
    `MAX_ROW_REQUESTS` grows by 2.
  - AVIF stays as it is (non-goal).

### 7. A hostile page costs one page, never the pass

- **`MEASURE_SCRIPT` moves to the isolated world** (`isolatedEvaluate`, the same CDP world as the
  image and axe scripts), so page globals cannot reach it.
- **Its result is shape-checked.** A value that is not the expected integers is recorded on that
  page as `render_error: "measurement returned an invalid shape: …"`. It never reaches the write
  and never stops the pass.
- **Every page gets one render deadline.**
  - It is navigation budget + `RENDER_POST_SETTLE_ALLOWANCE_MS` + `RENDER_AXE_ALLOWANCE_MS`,
    the same sum the crash-resume lease already assumes, so the lease and the deadline agree.
  - It covers navigation, settle, measurement, images, axe and `page.content()`.
  - On expiry: the page's isolated-world script is terminated (`Runtime.terminateExecution`, as
    axe does), the page is closed, and the row records
    `render_error: "render over N s in total"` with the phase it was in. The pass continues.
  - `analyzeHtml` is our own synchronous code and is not covered. It is bounded by its own caps.
- A failure that comes from our own code (a phase-2 throw) still stops the pass, as today
  (hard rule 7).

### 8. `simhash64` without the garbage

- **Same output, bit for bit.** The four golden values in `test/crawl/simhash.test.ts` stay. A
  new property test runs the current implementation, kept in the test as an oracle, against the
  new one over random text, including non-ASCII, surrogate pairs, and texts under 4 words.
- **How:**
  - Do the FNV-1a 64 arithmetic on two 32-bit halves (`Math.imul` plus carries), not on BigInt.
  - Hash each 4-word window by feeding the words and separators straight into the hash, without
    building the joined string or the window array.
  - The 64 output BigInts become one at the end.
- **Target:** at least 5× less allocation per page on the profile the 29b gate used (from about
  11.5 MB to about 2.3 MB or less). The page hashes twice and the renderer hashes again, so it
  pays three times.

### 9. Link derivation with room to spare

All three derivations (click depth, link counts, link score) join `links.target_url` to
`pages.url` as text, because the crawler writes `links.target_page_id` as null.

- **New first derivation `deriveLinkTargets`:**
  - One SQL `UPDATE` fills `links.target_page_id` for the crawl's internal links whose target
    was crawled.
  - It is guarded with `is distinct from`, so a re-run writes nothing.
  - The existing `(crawl_id, target_page_id)` index becomes useful.
- **Click depth, link counts and link score join on the integer id.**
- **Click depth's frontier:**
  - Each BFS level selects `click_depth = $d` over all the crawl's pages.
  - It moves to a temp frontier table (one row per page at the current depth), or a partial
    index if that measures better. The plan settles which, by measurement.
- **Budgets in `scripts/gate-rules.ts`:**
  - `GATE_LINK_DERIVE_MS` stays at 60 s. It now covers `deriveLinkTargets` + counts + score.
  - A new `GATE_CLICK_DEPTH_MS` is set at 30 s.
  - The target is 40 s for the first sum, leaving 20 s of room, and 30 s for click depth.
- Results must not change: the 29c gate's derived values (depths, counts, scores to 1e-9) are
  compared on the 50k fixture before and after.

**As built (2026-11-24).** `deriveLinkTargets` was measured and NOT shipped. Persisting
`links.target_page_id` cost about 70 s at 50k on a first run (68.6 s for the `SET`, against
about 11 s the integer joins saved). A shared session temp table of resolved targets (no
persisted id, read by all three derivations) measured 88–89 s for link derive on the
synthetic 50k, against 70.6 s for the URL joins plus the click-depth frontier table. So all
three derivations still join `links.target_url = pages.url`, and the `(crawl_id,
target_page_id)` index stays unused. Click depth uses the `cd_frontier` temp-table pair
(24.1 → 8.6 s on the synthetic 50k; the partial-index variant measured 24.0 s).
`GATE_LINK_DERIVE_MS` (60 s) covers counts + score only, and `GATE_CLICK_DEPTH_MS` (30 s)
click depth. The 40 s target and "comfortable room" are likely unmet: link counts alone is
about 53 s on the synthetic 50k (24.6 s on the 29c gate crawl). Whether the 60 s clause
stands is an owner decision at the gate.

### 10. The suite leaves no process behind

In `test/worker/serve.test.ts`:
- **Every child is registered when it is spawned.** `launch()` itself pushes to `children[]`,
  so the two direct `serve.ts` launches (`:504`, `:514`) and `api:serve` (`:458`) are covered.
- **`afterEach` SIGTERMs, then SIGKILLs after a grace period.**
- **`spawnTrusted`'s ready timeout kills its child** before rejecting.
- **The `until(...)` wait in the trust-variable test is shorter than `testTimeout`,** so the
  test fails with its own message, not vitest's.
- **A vitest `globalSetup` teardown kills any pid still recorded.** That covers a crashed
  worker file.
- A check at the end of the suite fails loudly if a `serve.ts` child is still alive.

## Non-goals

- **The non-code items:**
  - re-crawling greenpeople.co.uk needs the store's Shopify crawler signature (owner action);
  - the validator.schema.org check on the last three sample pages.

  Both stay open in the 29a gate doc.
- **Per-crawl sitemap timing.** 27d built the timing (60 s headers, 30 s idle, 120 s document,
  10 min walk) as constants, and Hurtigruten reads every sitemap. Constants remain until a client
  asks.
- **AVIF continuation reads**, CSS background images, `srcset` candidates never fetched.
- **Browser presets** (e.g. a Chrome user-agent). The robots token a browser identity should
  match has no right answer. A custom `userAgent` with an explicit `robotsUserAgent` covers it.
- **Pagination from `rel=next`/`rel=prev`.** Rule 1 uses the URL only.
- **A separate test database** (still its own decision, as in 27d).
- **The HTTPS fixture for `social.image-insecure`** (judged not worth it in 26c and 27d).
- **Click depth on crawls judged before ruleset 0.7.0** (29c §7). No such crawl is kept.

## Constraints

- Hard rules 1–10. Especially:
  - every new count has a not-measured state for older extractions (1, 7);
  - link work stays SQL (3);
  - the memory contract (6);
  - politeness (9): continuation reads go through the host gate, and presets never bypass a
    challenge.
- `EXTRACTION_VERSION` 5 and a new ruleset (0.29.0). Each bump is recorded in its doc block.
- Migrations only through drizzle-kit and `npm run db:migrate`. One data migration is expected,
  for stored PDFs' `is_indexable`. Every other new value sits in jsonb or in an existing column.
- No fallbacks:
  - a missing robots token is derived and stored visibly, or refused;
  - a missing count on an old page is "not measured", never 0.

## Surface changes (Talos-facing)

- **Crawl config:** `userAgentPreset` and `robotsUserAgent` (start body, `crawl_get`, MCP
  `crawl_start`). Neither is mutable.
- **Robots evidence** names the token matched.
- **`structured_data` listing, MCP tool and CSV:** `blocksDropped` and `nodesDropped`. Each is
  null, meaning not measured, below extraction 5.
- **`schema.unresolved-reference` evidence:** the unresolved references and `unresolvedCount`.
- **Hreflang findings** can now name a PDF as the declarer.
- **PDFs count as indexable** unless `X-Robots-Tag` says `noindex`. This shows in `pages_query`,
  the health counts, sitemap findings and the diff, and stored crawls are rewritten by the
  migration.
- **Page types:** a numeric last segment keeps `:id` beside a slug type. This shows in every
  `pageType` filter and cohort.
- **`render_error`** gains two reasons: invalid measurement shape, and over the total deadline.
- `docs/talos-surface.md`, the MCP descriptions and the skills are updated for each.

## Gate 29d

1. **Suite and types.** The full suite and `tsc` are clean. After the suite, no `serve.ts`
   process is left (checked by the suite itself and by `pgrep` after the run).
2. **Each goal has fixtures:**
   - pagination pages typed `:id` beside slug posts, with no template finding;
   - a block whose 60th reference is the only unresolved one gets a finding;
   - microdata and RDFa with two types; 60 blocks (10 dropped); a JSON-LD graph 7 deep;
   - a PDF declaring hreflang with a missing return link;
   - a robots.txt with a `Googlebot` group and a `*` group, crawled with each preset and with a
     custom `Mozilla/` user-agent (400);
   - a square PNG and a 40×20 PNG with 100 KiB before IDAT, plus a JPEG with 100 KiB of APP
     segments, served with ranges;
   - a page that overrides `Array.from` and `Array.prototype.filter`, and a page that never
     finishes its scripts.
3. **The 50k gate** (needs an owner OK for the gate DB `ariadne_gate29d`):
   - peak memory within the 306.4 MB local bound;
   - link derive ≤ 60 s, with a target of 40 s;
   - click depth ≤ 30 s;
   - derived values identical to a pre-change run.

   As built (2026-11-24): link derive is counts + score only (`deriveLinkTargets` was
   measured and not shipped, see goal 9's note); the 40 s target is likely unmet (link
   counts about 53 s on the synthetic 50k), and the 60 s clause is an owner decision at
   the gate.
4. **Allocation.** The `simhash64` profile shows at least 5× less garbage per page.
5. **Real site (needs owner OK at gate time).** A lavishalice.com crawl: the 16 pagination
   pages no longer appear in `schema.template-inconsistent`, and every other rule's count is
   explained against the 29c crawl.

## Calls I made (owner to check)

1. **Scope.** Everything above is in. Out: per-crawl sitemap timing, AVIF, browser presets,
   and the two non-code items.
2. **Pagination** is told by the URL alone: a numeric last segment never joins a slug type. The
   cost is that a mixed numeric/slug detail type splits in two (missed findings, never false
   ones).
3. **Presets:** `ariadne`, `googlebot-smartphone`, `googlebot-desktop`, `bingbot`. The
   `userAgent` strings are copied verbatim from the engines' own docs.
4. **A custom `Mozilla/…` user-agent** without a robots token is refused, not guessed.
5. **Continuation reads:** at most 2 per image, PNG and JPEG only.
6. **Render deadline** = navigation budget + 30 s + 35 s (the lease's sum).
7. **One PR** for the whole phase, as 27d did. The tasks are independent, so it can be cut in
   two if the owner prefers.

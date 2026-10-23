import { sql } from "drizzle-orm";
import {
  pgTable, text, integer, bigint, boolean, jsonb, timestamp, real,
  primaryKey, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import type { StoredHostSpacing } from "../crawl/politeness.js";
import type { StoredPlatformProfile } from "../crawl/platform.js";

export const crawls = pgTable("crawls", {
  id: text("id").primaryKey(),                 // e.g. crawl_<ulid>
  siteUrl: text("site_url").notNull(),
  config: jsonb("config_jsonb").notNull(),
  rulesetVersion: text("ruleset_version").notNull(),
  // queued|running|finished|failed|cancelled. `running` and the three terminal
  // values are written by the crawl loop (src/crawl/loop.ts, `CrawlSummary
  // .status`); `queued` is written by the API's crawl queue, which creates the
  // row when a crawl is ACCEPTED and runs it when its turn comes
  // (src/api/service.ts) — so a queued row is durable work that no process has
  // started, and it is never a summary outcome.
  //
  // Free text, no enum constraint, so adding a value is a code change and not a
  // migration — which means every consumer must be audited by hand when one is
  // added. Today there are exactly two readers: `runRenderPass`'s liveness
  // guard (src/crawl/render/run-render.ts), which refuses `running` and
  // `queued`, and the API's crawl serialisation. No rule reads this column.
  status: text("status").notNull().default("running"),
  // WHY THIS CRAWL IS `failed` — one sentence, never a stack (migration 0017,
  // P18).
  //
  // THE CONTRACT, and it is an implication rather than an equivalence:
  // `failure_reason IS NOT NULL` ⟹ `status = 'failed'`. Every writer that
  // closes a row `failed` writes one, and every writer that closes a row any
  // other way writes NULL over whatever stood there — so a resume that
  // finishes a crawl an earlier run failed does not leave the old sentence
  // sitting under a `finished` status. Three writers exist and there are no
  // others: `closeCrawl` in src/crawl/loop.ts (which REFUSES a `failed` close
  // with no reason and a non-`failed` close with one), the API queue runner's
  // catch, and `markCrawlFailed` (src/api/service.ts).
  //
  // THE CONVERSE DOES NOT HOLD, and the null is why the column is nullable
  // rather than a `not null default ''`: a `failed` row with a NULL reason is a
  // PRE-0017 ROW — closed by a loop that had no column to write into. It is not
  // "the crawl failed for no reason", and no surface may render it as one. The
  // demo page says exactly that sentence rather than inventing a cause.
  //
  // WHAT GOES IN IT. The FIRST LINE of the error's own message, or — on the
  // robots-unreachable path — the classified sentence the loop already composed
  // for the summary (`robots.txt unreachable after 3 attempts (HTTP 502):
  // complete disallow`). Never a stack: the stack goes to the process log as it
  // always has, and this column carries the sentence a reader needs. It is
  // SERVED (`CrawlDetail.failureReason`), so it is a diagnostic string on the
  // `render_error` precedent one table along — engine-originated text, first
  // line only, no frames — and not client copy.
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  pagesCrawled: integer("pages_crawled").notNull().default(0),
  pagesTotal: integer("pages_total"),
  renderPassCount: integer("render_pass_count").notNull().default(0),
  // The widest per-host spacing the crawl's politeness gate has escalated to,
  // in milliseconds — `HostGate.maxSpacingMs()`, written by the crawl loop when
  // it changes so a poller can watch it move (src/crawl/loop.ts).
  //
  // Nullable, and the null is load-bearing: it means "no crawl loop ever
  // reported one" — a row that predates this column, or a crawl that failed
  // before its gate existed. It is NOT zero, which would be a real spacing (a
  // crawl configured with perHostDelayMs 0 and never throttled). A reader that
  // conflates the two would report an unpaced crawl as un-instrumented, or the
  // reverse (hard rule 7).
  hostSpacingMs: integer("host_spacing_ms"),
  // The SAME finding, per host, written by the crawl loop beside `host_spacing_ms`
  // (migration 0015, P13-T3). TWO SHAPES, both read by `HostGate.restore()`:
  //  - pre-24a: `{ host: earnedMs }` (the old `maxSpacingMsByHost()`);
  //  - Phase 24a on: `{ host: HostSpacingEntry }` (`HostGate.snapshot()`) —
  //    `{ spacingMs, baseMs, responses429, retryAfterSeen, escalations,
  //    recoveries, recoveryLocked, peakSpacingMs }`, the host's current spacing
  //    plus its whole ratchet state (base, cumulative escalations, recoveries
  //    — one level each — and the two-strike lock) and its throttle counters, so a resume
  //    keeps the host's place on the ratchet. No column change: jsonb shape only.
  // A row never mixes the two; `restore` throws on a mixed or malformed map.
  // `host_spacing_ms` above is the WIDEST spacing any single host reached, so a
  // resume built from it alone widens EVERY host to the worst host's number — a
  // crawl whose CDN earned 8s while the origin stayed at 1s resumes the origin at
  // 8s too. This map is what lets each host re-enter ITS OWN earned spacing
  // instead: on a resume `HostGate.restore` folds each host's base (falling back to the
  // crawl-wide `host_spacing_ms`, then the config floor, for a host not in it)
  // into the same max(config, robots, earned) capped at 30s.
  //
  // NULLABLE, AND THE NULL IS LOAD-BEARING, as `host_spacing_ms`'s is — but it
  // means one thing more precisely: "no 0015-aware loop ever wrote this crawl a
  // map". A crawl that predates the column, or one that failed before its gate
  // existed. NOT the empty object `{}`, which a 0015 crawl writes when its loop
  // ran but touched no host worth recording yet — the map's null-vs-empty is the
  // column-vs-crawl distinction `host_spacing_ms`'s null-vs-zero is. There is NO
  // BACKFILL: a pre-0015 crawl kept only the crawl-wide number, and a resume of
  // one falls back to it exactly as before — honest degradation in the polite
  // direction (the widest, applied to all), never a fabricated per-host split
  // (hard rule 7). `host_spacing_ms` STAYS: it is that fallback, and it is the
  // number `crawl_status` already serves a poller (the per-host map is resume
  // machinery, not a poll surface).
  hostSpacingJsonb: jsonb("host_spacing_jsonb").$type<StoredHostSpacing>(),
  // Three crawl-level evidence blobs the query rules read instead of fetching
  // (hard rule 3: rules read the database). All three are nullable, and a null
  // does NOT mean the same thing in each — what a rule may conclude from one
  // depends on when its writer runs:
  //
  //  - `discovery` (what robots.txt said and what the sitemap walk found) is
  //    written by `runCrawl` unconditionally, immediately after `discover()`
  //    and before the frontier is seeded or anything branches on it. There is
  //    no path that crawls a site and leaves it null. A null is therefore not
  //    "not attempted": it is a row no completed discovery produced — one that
  //    predates the column, or a crawl that died inside discovery — and the
  //    robots and sitemap rules THROW on it rather than judging a site on
  //    evidence that is not there (hard rule 7). See
  //    src/rules/query/crawl-evidence.ts.
  //  - `hostProbe` (the www/apex/http variant walk) is skipped entirely when
  //    the caller passes `probeHosts: false`, and has no "skipped" shape to
  //    record that in. A null here genuinely is "not attempted", and a rule
  //    reading it must report a skipped check rather than a finding.
  //  - `notfoundProbe` (the synthetic-404 sample the soft-404 rule compares
  //    pages against) always ends up written once the crawl reaches that step:
  //    either a sample, or a `{ skipped: <reason> }` object naming why it was
  //    not taken. A null means the crawl never got that far — it is still
  //    running, or it failed before the probe — which is again "not attempted"
  //    and again a skipped check, not a finding.
  discovery: jsonb("discovery_jsonb"),
  hostProbe: jsonb("host_probe_jsonb"),
  notfoundProbe: jsonb("notfound_probe_jsonb"),
  // When the rule runner last finished a full pass over this crawl.
  //
  // WRITTEN BY `runRules` (src/rules/run.ts) AND BY NOTHING ELSE, at both ends
  // of a run: cleared to null in the same transaction as the delete that
  // removes the previous run's `issues` rows, and stamped once every rule and
  // every metric has been written. A null therefore means "no complete rule
  // pass is on record for this crawl" — never judged, being judged right now,
  // or judged by a run that died part-way — and a timestamp means the `issues`
  // and `metrics` rows beside it are one completed pass's.
  //
  // That distinction is the whole reason for the column: an empty `issues`
  // table on a crawl that was never judged and one on a crawl that was judged
  // and found clean are different facts, and nothing else can tell them apart
  // (hard rule 7). The agent surface exposes it as `rulesRunAt`.
  rulesRunAt: timestamp("rules_run_at", { withTimezone: true }),
  // The explicit render list, verbatim as the agent supplied it. NULL means no
  // explicit pass was requested — automatic selection, or no render at all;
  // render_pass_count says whether A pass ran, this says who chose the pages.
  // Until migration 0012 this lived under RENDER_URLS_KEY in config_jsonb
  // (the amended-doctrine detour recorded in the Phase 8 gate §12); 0012
  // backfills it out and this column is the only home.
  //
  // Written by `recordRenderSelection` (src/crawl/render/run-render.ts), in the
  // same transaction as the selection it describes, and read by
  // `render.coverage` (src/rules/metric/render-metrics.ts) to say which of the
  // two decisions chose this crawl's render set. Every pass overwrites it, so
  // it always describes the LAST selection — a crawl rendered from a list and
  // then rendered automatically must stop saying "explicit".
  renderUrlsJsonb: jsonb("render_urls_jsonb"),
  // Written by inferPageTemplates at crawl end: {shapesBefore, typesAfter,
  // retyped, at}. NULL is a pre-Phase-8 crawl or one whose inference never
  // ran — the ambiguity docs/gates/phase-8.md §7.2 warns about, now a column
  // instead of a log line. Never backfilled: the old runs' numbers exist only
  // in logs, and a guessed backfill would be a silent fallback (rule 7).
  //
  // LAST-RUN SEMANTICS, like render_urls_jsonb beside it. A resumed crawl runs
  // the inference again over the larger population and OVERWRITES all four
  // fields, `at` included — so this describes the most recent pass, not the
  // first. That is the only reading that stays true: the pass is idempotent by
  // recomputation, so the counts it reports are the ones the population NOW
  // implies, and a preserved first-write `at` would date numbers that have
  // since moved.
  templateInferenceJsonb: jsonb("template_inference_jsonb"),
  // How many of this crawl's pages carried more resource references than the
  // analyzer's `MAX_RESOURCE_REFS` cap keeps — the truncation, counted instead
  // of silent (migration 0014, P12-T1).
  //
  // REFERENCES TURNED AWAY, NOT FILES LOST, and every surface that serves this
  // number repeats the distinction. Past the cap the analyzer stops resolving,
  // so it cannot know whether a turned-away reference was a new URL or a repeat
  // of one already in the page's list: a page whose 2,001st reference duplicates
  // its first is counted here and lost nothing. The flag claims what the
  // analyzer can see and nothing stronger (`PageAnalysis.resourceRefsCapped`).
  //
  // WHY IT IS A COLUMN AND NOT A QUERY. The same number is derivable from
  // `page_resources` — count the pages holding exactly the cap's worth of edges
  // — and Phase 11 measured that: 73 ms and 67 ms over a 500,000-edge crawl,
  // against a `crawl_status` whose other reads are ≤ 3 ms and which a dashboard
  // hits on every paint (docs/gates/phase-11.md §10.1). The obvious cheap form
  // was also disproved there: `pages.images_total` counts `<img>` ELEMENTS while
  // the extraction emits a DISTINCT-URL set, so comparing them fires on any page
  // that reuses an image and stays silent on a truncated page whose references
  // happen to be distinct. So the count is CARRIED: the analyzer flags the page,
  // `PageWriter` counts the flagged pages, and `closeCrawl` stamps the total —
  // O(pages), in a place every page already passes through.
  //
  // NULLABLE, AND THE NULL IS LOAD-BEARING, exactly as `host_spacing_ms`'s is.
  // Null means "nobody counted", and there are THREE ways to get one:
  //
  //  1. A crawl written before this migration. Never backfilled — the edge table
  //     cannot reconstruct which pages were truncated, and a guess would be a
  //     fabricated measurement (hard rule 7).
  //  2. A crawl still running, or one whose process died and was never resumed.
  //  3. A crawl that persisted pages and then died before its first close, and
  //     was later RESUMED. The dead run's pages were counted in a process that
  //     is gone, and the resume adds to the column rather than replacing it
  //     (below), so `null + n` keeps it null — PERMANENTLY, on that crawl. That
  //     is deliberate and not a gap to close later: the resume genuinely does
  //     not know how many of the earlier run's pages were truncated, and
  //     stamping its own partial count would publish a number that reads like a
  //     whole one. A crawl in this state answers "we do not know" for ever, and
  //     a fresh crawl is what produces a number.
  //
  // ZERO IS A MEASUREMENT: the analyzer read every page of that crawl and none
  // of them lost a reference.
  //
  // A RESUMED CRAWL ADDS TO IT rather than overwriting it, because a resume's
  // writer only ever saw the pages that resume fetched. The addition is done in
  // SQL so a null stays null (`null + n` is null) — which is both how case 3
  // above stays honest and why a crawl whose first run predates this column
  // cannot become a partial count. See `closeCrawl` in src/crawl/loop.ts.
  resourceRefsCappedPages: integer("resource_refs_capped_pages"),
  // When a 5xx recheck pass COMPLETED over this crawl (migration 0016, P17-T1).
  //
  // The `rules_run_at` precedent, and it exists for the one reader the page
  // columns cannot serve: "did a pass run over this crawl at all". On a crawl
  // with zero server errors the two answers differ — this is stamped and no
  // page carries anything — and that difference is the honest distinction
  // between "this site had no server errors" and "nobody looked" (hard rule 7).
  //
  // NULL MEANS NO COMPLETE PASS IS ON RECORD: a crawl written before 0016, one
  // still running, one that failed before the pass, or one whose pass was
  // ABORTED — a cancelled pass is deliberately not stamped, because the rows it
  // never reached are still unasked.
  recheckPassAt: timestamp("recheck_pass_at", { withTimezone: true }),
  // How many rows the LAST pass rechecked.
  //
  // THE `render_pass_count` PRECEDENT, WITH ITS TRAP: a 0 here says "rechecked
  // nothing", which is exactly what a crawl nobody ever rechecked also reports,
  // because the column is NOT NULL DEFAULT 0 and has no null to distinguish
  // them with. `recheck_pass_at` is what tells them apart, and every reader
  // that quotes this number must read that one beside it.
  //
  // LAST-RUN SEMANTICS, like `render_urls_jsonb`: an aborted pass stamps what
  // it actually did (and no `recheck_pass_at`), and a resume overwrites the
  // count with its own — which is the only reading that stays true, since the
  // resumed pass asks only the rows the interrupted one never reached.
  recheckPassCount: integer("recheck_pass_count").notNull().default(0),
  // Robots-disallowed internal URLs the crawl TURNED AWAY because their own
  // budget (`CrawlConfig.maxBlockedUrls`, default `maxPages`) was full
  // (migration 0020, Phase 23 T3, study D1).
  //
  // Below the budget such a URL is a `pages` row — `fetch_class = 'disallowed'`,
  // `fetch_reason = 'robots.txt: <the matching line>'`, never requested — and
  // `robots.blocks-internal-urls` reports it with its inlinks. Past the budget
  // it is counted HERE instead of written, so a robots.txt that disallows a
  // faceted URL space (`Disallow: /search`, `?filter=` on every page) costs a
  // bounded number of rows and the overflow is a number, not a silence (hard
  // rule 7).
  //
  // DISCOVERIES TURNED AWAY, NOT DISTINCT URLS — the `resource_refs_capped_pages`
  // precedent. The crawl keeps no set of the URLs it turned away (that set is
  // the O(URLs) structure the budget exists to avoid, hard rule 6), so one
  // blocked URL linked from three pages after the budget filled counts three.
  // A URL that already HAS a row is never counted here. Read it as "the list is
  // incomplete, by up to this many discoveries" — `robots.blocks-internal-urls`
  // turns a non-zero count into its truncation note.
  //
  // NULLABLE, AND THE NULL IS LOAD-BEARING: null means nobody counted — a crawl
  // written before 0020, or a resume of one (`null + n` stays null in SQL, as
  // `resource_refs_capped_pages`' resume does). Every crawl the 0020 loop starts
  // writes 0 before its first enqueue, so 0 is a measurement: nothing was
  // turned away.
  robotsBlockedDropped: integer("robots_blocked_dropped"),
  // WHETHER THE FRONTIER CAP TURNED A NEW URL AWAY (migration 0023). True the
  // first time `enqueue` met a URL the frontier did not hold and had no room
  // left under `maxPages` for it: from then on the crawl's link graph is known
  // to be partial, whatever `pages_crawled` ends at. That is the case
  // `pagesCrawled >= maxPages` cannot see — a crawl the residual reservation
  // race left short of its cap with nothing pending (see `enqueue` in
  // src/crawl/loop.ts) — and `links.orphan` reads it beside that comparison.
  //
  // NULLABLE, AND THE NULL IS LOAD-BEARING, exactly as `robots_blocked_dropped`'s:
  // null means nobody watched — a crawl written before 0023, or a resume of one
  // that never met the cap. Every crawl the 0023 loop starts writes false before
  // its first enqueue, so false is a measurement: no new URL was turned away.
  frontierCapped: boolean("frontier_capped"),
  // THE PLATFORM THE SITE'S OWN HEADERS NAMED, and the profile that followed
  // (migration 0024; src/crawl/platform.ts). `platform` is read off the first
  // classifiable response (an `ok` HTML page from the crawl's origin): the
  // host probe's, or the seed fetch's when the probe is off.
  //
  // NULLABLE, AND THE NULL MEANS ONE THING: no platform was named — the
  // headers named none (including a Shopify store whose CDN strips them), no
  // classifiable response came back, or the crawl predates 0024. The caller's
  // own settings applied. `platform_profile_jsonb` is null exactly when
  // `platform` is; when it is set it holds what was applied and when, or that
  // the operator opted out (`StoredPlatformProfile`).
  platform: text("platform"),
  platformProfile: jsonb("platform_profile_jsonb").$type<StoredPlatformProfile>(),
});

export const pages = pgTable("pages", {
  id: text("id").primaryKey(),
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  urlNormalised: text("url_normalised").notNull(),
  pageType: text("page_type"),
  statusCode: integer("status_code"),
  // ok|redirect|client_error|server_error|blocked|timeout|network_error|
  // non_html|too_large|unsupported_encoding|disallowed — the `FetchClass`
  // union in src/crawl/fetch-page.ts is the authority; this comment tracks it.
  fetchClass: text("fetch_class").notNull(),
  // Why this row has no usable body or redirect target, in the words the fetch
  // layer produced (`FetchResult.disallowedReason`). Null for a page that
  // simply worked, and null for a failure whose class already says everything
  // — a 404 needs no sentence.
  //
  // It exists because a class alone is not an explanation, and hard rule 7
  // asks for the error to be *visible*, not merely counted: `unsupported_
  // encoding` without "(br)" and `redirect` with a silently dropped Location
  // are both rows a reader can only guess at. Tenant-safe by construction —
  // the fetch layer builds these from the response and the URL policy, never
  // from a stack trace or a local path.
  fetchReason: text("fetch_reason"),
  contentType: text("content_type"),
  redirectUrl: text("redirect_url"),
  // The same target as `redirect_url`, put through `normalizeUrl` — the
  // spelling `pages.url` is keyed by, and therefore the only spelling a join
  // to `pages` can use. `redirect_url` keeps the resolved `Location` verbatim,
  // because that is what the server sent and what the evidence quotes; a
  // `Location` carrying a fragment or unsorted query params is the same URL as
  // the page row the crawl created from it, and only this column says so.
  //
  // Null in three cases, and they are one fact: there is no crawlable target.
  // No redirect at all, a 3xx with no usable `Location`, and a target the URL
  // policy refused all leave `redirect_url` null too.
  redirectUrlNormalised: text("redirect_url_normalised"),
  depth: integer("depth").notNull(),
  discoveredVia: text("discovered_via").notNull(), // seed|link|sitemap|redirect
  title: text("title"),
  metaDescription: text("meta_description"),
  canonicalHtml: text("canonical_html"),
  canonicalHeader: text("canonical_header"),
  // How many <link rel=canonical> elements the HTML declared. `canonical_html`
  // keeps the first; this counts them all, because "more than one canonical"
  // (CHECK-18) is a finding a single-value column cannot express.
  canonicalCount: integer("canonical_count").notNull().default(0),
  robotsMeta: text("robots_meta"),
  xRobotsTag: text("x_robots_tag"),
  isIndexable: boolean("is_indexable"),
  ogTitle: text("og_title"),
  ogDescription: text("og_description"),
  ogImage: text("og_image"),
  h1Count: integer("h1_count").notNull().default(0),
  h2Count: integer("h2_count").notNull().default(0),
  h3Count: integer("h3_count").notNull().default(0),
  h4Count: integer("h4_count").notNull().default(0),
  h5Count: integer("h5_count").notNull().default(0),
  h6Count: integer("h6_count").notNull().default(0),
  headingOrder: integer("heading_order").array(),
  // The first <h1>'s text, whitespace-collapsed and capped at 300 chars by the
  // analyzer. Null means the page carried no <h1> at all; '' means it carried
  // an empty one — the present-but-blank distinction `title` and
  // `meta_description` already make, and rules read it through `present()`.
  //
  // WRITTEN BY THE CRAWL (`PageWriter`, off the analyzer's single pass) FROM
  // PHASE 7 ONWARD; null on every row a pre-P7 crawl wrote. The CAPTURE landed
  // here with the analyzer work in P7-T1 because the analyzer is the only place
  // the page's text is ever in memory (hard rule 2: rules do not fetch), and a
  // rule cannot read a column no crawl ever wrote.
  //
  // Its consumer is `h1.duplicate-text` (P7-T2, src/rules/query/field-duplicates.ts),
  // which groups indexable pages by this exact value. The null is a GATE for
  // that rule the same way `renderable_word_count`'s is for the thin one: a
  // pre-P7 crawl has null here on every row, the grouping finds nothing, and
  // "no duplicate headings" and "no headings were ever read" are the same
  // silence. `h1.duplicate-skipped` is what tells them apart, on the condition
  // that no indexable page has text here while some carry an h1 at all.
  //
  // The stored value collapses the h1's descendant text with NO separator
  // (cheerio's `.text()` semantics, which the parity oracle holds the port to),
  // so `<h1>Big<br>Sale</h1>` is stored as `BigSale` — a ledgered limitation
  // the grouping rule inherits and states.
  h1Text: text("h1_text"),
  // Every word of visible text the HTML carries.
  //
  // SEMANTICS CHANGED IN PHASE 7 (migration 0010), and rows written before it
  // carry the old meaning: text inside a <template> used to be counted, and is
  // not any more. Template content lives in an inert DocumentFragment that is
  // in no document, under no CSS and in no index, so counting it was a defect
  // rather than a definition — on the page that provoked the change it was 482
  // of 1,413 words. There is NO BACKFILL: a word count cannot be recomputed
  // without the HTML, which the crawl does not store, and a pre-P7 crawl is not
  // a supported re-judge target (see `renderable_word_count`, whose null is the
  // gate that makes that refusal loud instead of silent).
  wordCount: integer("word_count"),
  // The same count minus the words the page's own MARKUP says are not
  // displayed: anything inside an element carrying `hidden`, an inline
  // `display:none`, a <dialog> that is not `open`, or the non-<summary> body of
  // a <details> that is not `open`. Written by the crawl (`PageWriter`) beside
  // `word_count`, from the same single pass, and always <= it.
  //
  // MARKUP-ONLY, and the limitation is the column's meaning rather than a
  // caveat on it: the analyzer never fetches or cascades CSS (hard rules 2 and
  // 4), so a class that hides its element through a stylesheet is invisible
  // here. This is a FLOOR on the correction — what remains between it and the
  // render pass's `rendered_word_count` is CSS-hidden text, which is evidence
  // about the site rather than error in the measurement.
  //
  // ITS PHASE 8 PARTNER is `rendered_renderable_word_count`: the same function
  // over the post-JavaScript DOM. That pair — not this column against
  // `rendered_word_count` — is what `content.csr-dependent` subtracts, because
  // only two readings by one instrument cancel the chrome they both contain.
  // See the family-2 block further down.
  //
  // NULLABLE, AND THE NULL IS A GATE. It means "no P7-or-later analyzer wrote
  // this row" — a pre-P7 crawl, whose `word_count` also carries the old
  // template semantics. The rules that read it (`content.soft-404`'s length
  // ceiling, `content.csr-dependent`'s comparison) must SKIP such a page loudly
  // rather than falling back to `word_count`, which measures a different thing.
  // A page the analyzer never ran on at all — a PDF, a 404 — stores null in
  // BOTH columns, and that is a different fact from this one.
  //
  // `content.thin`'s floor read this column between Phase 7 and Phase 19 §11
  // and now reads `main_word_count` instead: hiding is not the only way a page
  // ends up mostly furniture, and on a templated site it is not the usual one.
  renderableWordCount: integer("renderable_word_count"),
  // How many links from the crawl's entry point the shortest path to this page
  // is. Nullable; NOT the same thing as `depth`, which is the depth of the
  // frontier item that discovered the URL and counts a sitemap entry as 0.
  //
  // WRITTEN BY PHASE 7 TASK 4, and by nothing today: this column ships with
  // migration 0010 (with the three other P7 columns, so the phase adds one
  // migration and not four) and stays null until that task's writer lands. A
  // reader before then sees every row null, which is "no click depth was
  // computed" and must not be read as "depth 0".
  clickDepth: integer("click_depth"),
  // Visible-text bytes over HTML bytes. It reads the SAME accumulator
  // `word_count` does, so Phase 7's template exclusion moved it too (template
  // text is no longer in the numerator) — but it does NOT read the renderable
  // stream, so it still counts markup-hidden chrome as text. Correcting that is
  // a separate decision about what a text ratio is for and is deliberately out
  // of P7-T1's scope; `content_hash` and `simhash` sit on the same accumulator
  // and the same reasoning.
  textRatio: real("text_ratio"),
  contentHash: text("content_hash"),
  // The analyzer's simhash is in the UNSIGNED 64-bit range; this column is a
  // SIGNED Postgres bigint. Persistence stores `BigInt.asIntN(64, value)` and
  // readers recover the analyzer's value with `BigInt.asUintN(64, stored)`.
  // The bit pattern — all a hamming distance cares about — is identical either
  // way, so the round trip is lossless. See src/crawl/parse/simhash.ts.
  simhash: bigint("simhash", { mode: "bigint" }),
  // The same fingerprint over the page's MAIN CONTENT instead of over
  // everything it renders: the visible text inside the first <main> when the
  // document has one, else the body's visible text with the <nav>, <header>,
  // <footer> and <aside> subtrees removed. Written by the crawl (`PageWriter`)
  // off the same single pass as `simhash`, and stored on exactly the contract
  // stated on `simhash` above — unsigned analyzer value, signed column,
  // `BigInt.asIntN(64, …)` in and `BigInt.asUintN(64, …)` out.
  //
  // WHY IT EXISTS (migration 0018, Phase 19). `simhash` reads the whole visible
  // text, and on a templated site most of that text is the same header,
  // navigation and footer on every page: the crawl that provoked this carries
  // ~900 words of chrome around a median of ~150 words of content, so two
  // unrelated templates landed 3 bits apart and `content.near-duplicate`
  // reported 500 findings, 237 of them across pages with nothing to do with
  // each other. This column is what that rule compares now; `simhash` keeps its
  // meaning and its readers.
  //
  // NULLABLE, AND THE NULL IS A GATE, twice over:
  //  - "nothing to fingerprint" — an empty <main>, or a body that is nothing
  //    but chrome. Never `0` and never a hash of the empty string.
  //  - "this row predates 0018". PRE-0018 ROWS ARE NULL AND ARE NOT
  //    BACKFILLED: the text cannot be recomputed without the HTML, which the
  //    crawl does not store. A rule meeting a crawl with no main fingerprint
  //    must SAY SO rather than pass — `content.near-duplicate-skipped` is how
  //    (hard rule 1), on the `content.thin-skipped` precedent.
  mainSimhash: bigint("main_simhash", { mode: "bigint" }),
  // Words in the text `main_simhash` was taken over. Written with it, null with
  // it, and read by two rules: as the floor under a near-duplicate claim (a page
  // with less main content than the threshold has nothing to be a near-duplicate
  // OF), and — since Phase 19 §11 — as `content.thin`'s own floor, which is the
  // check that owns those pages. THE NULL MEANS TWO THINGS AND ONLY THE CRAWL
  // SAYS WHICH: "this page has no main content at all" on a 0018 crawl, and
  // "nothing here was ever measured" on an older one. `content.thin` reports
  // the first as zero words and `content.thin-skipped` reports the second,
  // which is why both are query rules — the census that separates them is a
  // question about the crawl.
  mainWordCount: integer("main_word_count"),
  // Up to 160 characters of the visible text around the first "lorem ipsum"
  // match — the EVIDENCE for `has_lorem_ipsum`, which without it reports a URL
  // and a word count. The finding that provoked it was true and unusable: three
  // 1,000-word blog posts whose placeholder copy was the card excerpt and the
  // meta description, which no reader could find from `{wordCount}`.
  //
  // NULL EXACTLY WHEN `has_lorem_ipsum` IS FALSE. The two are one observation
  // written twice — the flag and the quotation behind it — and the invariant is
  // asserted as SQL over the table in test/db/migration-0018.test.ts. Pre-0018
  // rows carry a flag and no snippet and are not backfilled, for the same
  // reason as the pair above: the text is gone.
  placeholderSnippet: text("placeholder_snippet"),
  // WHERE THE HEAD ENDED (migration 0021, Phase 23 T5). The analyzer runs the
  // tree builder's head rules over the token stream: the head closes at
  // `</head>`, at `<body>`, at the first element a head does not allow, or at
  // the first non-whitespace text. `head_closed_by` names the IMPLICIT closer
  // (`img`, `div`, `#text`, `body`, `</html>`); null when `</head>` closed it
  // explicitly or it never closed. The four booleans after it are
  // FIRST-OCCURRENCE flags: true when the first title, meta description, meta
  // robots or canonical in the document (the one the stored value is read from)
  // came after that point — a body duplicate of an in-head tag is false. The
  // hreflang column counts every alternate after that point. ALL SIX ARE NULL ON PRE-0021 ROWS, and
  // the rules read a null flag as "not measured", never as "inside the head";
  // a 0021 row always carries all five flags, so `head_closed_by` alone being
  // null is only ever the explicit or never-closed case.
  headClosedBy: text("head_closed_by"),
  titleOutsideHead: boolean("title_outside_head"),
  metaDescriptionOutsideHead: boolean("meta_description_outside_head"),
  robotsOutsideHead: boolean("robots_outside_head"),
  canonicalOutsideHead: boolean("canonical_outside_head"),
  hreflangOutsideHeadCount: integer("hreflang_outside_head_count"),
  // JSON-LD blocks on this page that would not parse (invalid JSON, or over
  // the analyzer's per-block cap). A count, not a silence: a page whose
  // structured data does not parse is an audit finding.
  structuredDataParseErrors: integer("structured_data_parse_errors")
    .notNull()
    .default(0),
  responseTimeMs: integer("response_time_ms"),
  htmlBytes: integer("html_bytes"),
  domSize: integer("dom_size"),
  imagesTotal: integer("images_total").notNull().default(0),
  imagesMissingAlt: integer("images_missing_alt").notNull().default(0),
  // <img> missing EITHER width or height — the CLS signal (CHECK-49). One
  // image counts once however many of the two it is missing: the browser
  // cannot reserve the box without both, so one attribute is the same
  // layout-shift defect as none (src/crawl/parse/page-analyzer.ts).
  imagesMissingDimensions: integer("images_missing_dimensions").notNull().default(0),
  hasAmp: boolean("has_amp").notNull().default(false),
  // <meta name=viewport> present — the mobile-readiness signal (CHECK-52).
  hasViewport: boolean("has_viewport").notNull().default(false),
  // Placeholder copy shipped to production (CHECK-40).
  hasLoremIpsum: boolean("has_lorem_ipsum").notNull().default(false),
  // Body text carrying a "page not found" phrase (CHECK-13). One of the two
  // soft-404 signals; the other is a simhash match against the site's own 404
  // template. A phrase alone is not a verdict — a real article about broken
  // links contains the words too — so the rule pairs it with a word count.
  hasSoft404Phrases: boolean("has_soft404_phrases").notNull().default(false),
  relNext: text("rel_next"),
  relPrev: text("rel_prev"),
  // The raw-HTML half of CHECK-34, written by `PageWriter` off the analyzer's
  // single pass: anchors carrying an href inside a <nav> / a <footer>, counted
  // exactly as `document.querySelectorAll('nav a[href]').length` counts them
  // (see the analyzer's parity oracle). NOT NULL with a 0 default because a
  // page with no HTML has no nav — a 200 that served a PDF, a 404, a timeout —
  // and 0 is that fact, not a missing value.
  //
  // FOR THE RULE THAT COMPARES THESE WITH THE RENDERED COUNTS (CHECK-34): they
  // carry a known −1 floor. An `<a href>` left open across a `<nav>` / `<footer>`
  // boundary is reconstructed INSIDE the container by a browser's tree builder
  // (the adoption agency algorithm), so the rendered DOM holds one anchor per
  // such tag that the raw byte stream never contained. A streaming tokenizer
  // cannot see it without being a DOM (hard rule 4), so the raw count can be
  // under the rendered one by 1 per unclosed anchor and is never over. The
  // threshold must tolerate ±1: a difference of one is malformed HTML, not
  // JavaScript-only navigation. Pinned by a named test in
  // src/crawl/parse/page-analyzer.upstream.test.ts.
  navLinkCount: integer("nav_link_count").notNull().default(0),
  footerLinkCount: integer("footer_link_count").notNull().default(0),
  // Which of the analyzer's `FRAMEWORK_MARKERS` the raw HTML carried, in that
  // constant's order. A jsonb array rather than a text[] because it is read as
  // a set (`framework_markers @> '["__NEXT_DATA__"]'`), and NOT NULL with an
  // empty-array default on the same reasoning as the two counters: no markers
  // is a fact about the page, never an absence of evidence.
  frameworkMarkers: jsonb("framework_markers")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  rendered: boolean("rendered").notNull().default(false),
  // ==========================================================================
  // MEASUREMENT FAMILY 1 — the browser's own `innerText` / DOM-selector counts
  // (P5-T4). Five columns, written by `MEASURE_SCRIPT` inside the page.
  // ==========================================================================
  //
  // What a READER sees: `innerText` excludes CSS-hidden copy and script bodies,
  // and `document.querySelectorAll` counts anchors as the DOM holds them. No
  // tokenizer can reproduce either number without doing layout (hard rule 4).
  //
  // WHO READS THEM SINCE PHASE 8. `rendered_nav_link_count` and
  // `rendered_footer_link_count` are `nav.js-only`'s rendered side;
  // `rendered_filter_link_count` is `filters.js-only`'s. `rendered_word_count`
  // and `rendered_link_count` are read by NO RULE: `content.csr-dependent`
  // stopped comparing against `rendered_word_count` in P8-T1 (see family 2) and
  // they are kept as EVIDENCE — the only number in the database that says what
  // a reader actually sees, which is what makes the CSS-hidden chrome on a page
  // computable at all (`renderable_word_count − rendered_word_count`).
  renderedWordCount: integer("rendered_word_count"),
  renderedLinkCount: integer("rendered_link_count"),
  // The render pass's side of the comparison, ALL WRITTEN BY THE RENDER PASS
  // (src/crawl/render, P5-T4) and by nothing else — the crawl's HTML path
  // leaves every one of them null. Nullable, and the null is the whole point:
  // it means this page was NOT rendered, which is what `isAuditable` gates on.
  // A rendered page with genuinely zero nav links stores 0; a page nobody
  // rendered stores null, and no rule may read the two as the same thing.
  renderedNavLinkCount: integer("rendered_nav_link_count"),
  renderedFooterLinkCount: integer("rendered_footer_link_count"),
  // Links the rendered DOM exposes that look like faceted-navigation filters —
  // the crawl-budget signal a raw-HTML crawl cannot see at all.
  renderedFilterLinkCount: integer("rendered_filter_link_count"),
  // ==========================================================================
  // MEASUREMENT FAMILY 2 — the SAME ANALYZER, run over the post-JavaScript DOM
  // (P8-T1, migration 0011). Written by the render pass and by nothing else.
  // ==========================================================================
  //
  // After the settle the renderer serialises `document.documentElement.
  // outerHTML` and runs `analyzeHtml` (src/crawl/parse/page-analyzer.ts) over
  // it — the very function the crawl ran over the bytes the server sent. So
  // `word_count` / `rendered_analyzer_word_count` and `renderable_word_count` /
  // `rendered_renderable_word_count` are two readings by ONE instrument, and
  // subtracting them is legitimate in a way subtracting family 1 from the
  // analyzer's columns never was.
  //
  // WHY THE FAMILY EXISTS. The Phase 7 gate (docs/gates/phase-7.md §4.2)
  // measured `renderable_word_count − rendered_word_count` across 28 rendered
  // pages of a real Shopify theme and found a NEAR-CONSTANT ~425-word offset —
  // class-hidden chrome the tokenizer counts and `innerText` does not. That
  // offset made `content.csr-dependent`'s firing condition arithmetically
  // unreachable on that crawl whatever the site did (§4.9): a zero that was not
  // a finding but an unanswerable comparison. The chrome markup is present in
  // BOTH documents, so measuring both with the same instrument cancels it.
  //
  // WHO READS THEM. `content.csr-dependent` (src/rules/query/render-diff.ts)
  // reads `rendered_renderable_word_count` against `renderable_word_count`;
  // `rendered_analyzer_word_count` travels in its evidence as the raw pair's
  // partner. Of the other three, `rendered_title` and `rendered_canonical` are
  // read by `render.title-changed` and `render.canonical-changed` (P23-T6,
  // the same file), and `rendered_h1_count` is still read by no rule — an
  // unread column is honest where a rule that always passes is not (hard
  // rule 1).
  //
  // ALL NULLABLE, and null means exactly one thing: this row was not rendered
  // by a Phase-8-or-later pass. A pre-P8 crawl has null here on every row and
  // CANNOT be re-judged — the rendered HTML of a finished crawl is not
  // recoverable — so a rule reading them must refuse the crawl loudly rather
  // than compare against a column that measures something else (the
  // `renderable_word_count` precedent, and `assertRenderedColumns` is where the
  // refusal lives).
  renderedAnalyzerWordCount: integer("rendered_analyzer_word_count"),
  renderedRenderableWordCount: integer("rendered_renderable_word_count"),
  // The `<title>` of the DOM the browser ended on, stored exactly as the raw
  // `title` column is: whatever the analyzer's text accumulator collapsed, with
  // no cap of its own (`text`, like `pages.title`). A page whose title is
  // rewritten by its own JavaScript is the drift this column makes visible.
  renderedTitle: text("rendered_title"),
  // `<h1>` elements the post-JS DOM holds, counted as `h1_count` counts them.
  renderedH1Count: integer("rendered_h1_count"),
  // The first `<link rel=canonical>` href in the post-JS DOM, stored as
  // `canonical_html` stores it. Nullable for TWO reasons that are not the same
  // fact, exactly as on the raw side: the page was not rendered, or it was and
  // it declares no canonical.
  renderedCanonical: text("rendered_canonical"),
  // Three more values from the same post-JS analysis (P23-T6, migration 0022),
  // each stored exactly as its raw twin is: `robots_meta` (the first
  // `<meta name=robots>` content, verbatim), `meta_description` (trimmed) and
  // `h1_text` (the first `<h1>`, whitespace-collapsed and capped at 300).
  // Their readers are the five raw-versus-rendered divergence rules in
  // src/rules/query/render-diff.ts.
  //
  // NULL MEANS TWO THINGS HERE, as it does for `rendered_canonical`: the
  // rendered DOM carried no such element, or no Phase-23 pass read it. The
  // second case is a pre-0022 rendered row, which has null in all three and
  // cannot be re-judged (the rendered DOM is not stored in the database). The
  // two are told apart by `rendered_tags_read` below, never by guessing.
  renderedRobotsMeta: text("rendered_robots_meta"),
  renderedMetaDescription: text("rendered_meta_description"),
  renderedH1Text: text("rendered_h1_text"),
  // True on every row a Phase-23-or-later render pass rendered successfully:
  // the three columns above were READ, so a null among them is "the rendered
  // DOM had none". Null on a failed or never-rendered row and on every row a
  // pre-0022 pass rendered — where a null in the three above is "not
  // measured", and the divergence rules that read them are silent rather than
  // reporting an element "removed by JavaScript" that nobody looked for
  // (hard rule 1). There is no `false`: the render writer stores true or null.
  renderedTagsRead: boolean("rendered_tags_read"),
  // Where this page's serialised post-JS DOM was written:
  // `<renderHtmlDir>/<crawlId>/<sha256(url)>.html`, git-ignored, one file per
  // rendered page. NOT in Postgres — a crawl's rendered HTML is tens of
  // megabytes and no rule reads it (hard rule 2: rules read the database) — but
  // on disk, because an auditor who disbelieves a render-diff finding needs the
  // document the numbers came from, which is the inspection story a Screaming
  // Frog user already expects.
  //
  // A WRITE FAILURE IS A CLASSIFIED `render_error`, never a null path beside
  // `rendered = true`: see `RenderResult` in src/crawl/render/renderer.ts.
  renderedHtmlPath: text("rendered_html_path"),
  // Where the page navigated itself to while rendering (a JS redirect): a URL
  // the HTTP layer never saw a Location header for.
  //
  // THIS COLUMN IS NOT GATED BY `rendered`, and the rule that reads it
  // (`redirect.js`, CHECK-10) must not gate on `rendered` either. When the
  // target is another origin the render pass records it and refuses to follow
  // it, which leaves the browser with no DOM of this site's to measure — so the
  // row is `rendered = false` with `render_error = 'off-site navigation: …'`
  // AND this column set. That is the most serious shape of the defect, so the
  // gate is `rendered_redirect_url is not null` (plus `fetch_class = 'ok'`, to
  // leave HTTP-level redirects to the redirect rules): a non-null value here is
  // itself render evidence.
  renderedRedirectUrl: text("rendered_redirect_url"),
  // Why a render that was ATTEMPTED produced nothing. Non-null here and null
  // in the four columns above is a rendered-and-failed page, which is a
  // different fact from a page that was never rendered (hard rule 7: the
  // failure is a recorded row, not a silently unrendered page).
  renderError: text("render_error"),
  // ---------------------------------------------------------------------------
  // THE TWO OBSERVATIONS (migration 0016, P17-T1).
  //
  // A page fetched once is a page whose 5xx nobody has re-checked, and the
  // recheck pass (src/crawl/recheck) exists to take a SECOND look at exactly
  // those rows. Both looks are kept: the first observation above is never
  // rewritten by the second, because `fetch_class` is the census every cohort
  // in this engine is cut from — `isAuditable`, the partial duplicate indexes
  // whose predicates spell `fetch_class = 'ok'`, `blockedPages`, `site.health`,
  // the render selection and the CSV views all read it — and a row flipped to
  // `ok` after the fact would be an `ok` page with no title, no words, no links
  // and no simhash: silently exempt from most of the ruleset while looking
  // healthy (hard rules 1 and 7).
  // ---------------------------------------------------------------------------
  //
  // WHEN THE FIRST OBSERVATION WAS TAKEN. Stamped by `PageWriter` on EVERY page
  // row it writes, off one `new Date()` per row; `resources.fetched_at` is the
  // precedent it borrows, and `crawls.started_at` is not a substitute because a
  // crawl is not a moment.
  //
  // NO OTHER WRITER TOUCHES IT. The render pass (`writeRenderResult`), the
  // click-depth derivation and the page-type inference all rewrite ANALYSIS
  // columns of a body this row already fetched, so moving the timestamp would
  // date the fetch by when we last thought about it. A resume does not re-stamp
  // it either: the page insert is `on conflict do nothing` on (crawl_id, url),
  // so a URL already in the table keeps the row — and the time — its first
  // observation wrote.
  //
  // NULLABLE, AND THE NULL IS LOAD-BEARING: "no 0016-aware writer wrote this
  // row", i.e. a crawl that predates this migration. NEVER BACKFILLED — a fetch
  // time cannot be reconstructed from a row, and stamping `started_at` on it
  // would publish a fabricated measurement (hard rule 7). The recheck pass
  // reads the null as "the gap between the two observations is unknown" and
  // reports `gapSeconds: null` rather than a number nobody measured, and falls
  // back to `passStart + MIN_RECHECK_GAP_MS` for the wait it owes that row.
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  // THE SECOND OBSERVATION'S CLASS, in the `FetchClass` vocabulary
  // (src/crawl/fetch-page.ts is the authority; this comment tracks it):
  // ok|redirect|client_error|server_error|blocked|timeout|network_error|
  // non_html|too_large|unsupported_encoding|disallowed.
  //
  // THE NULL CONTRACT, stated once here for all four recheck columns and
  // enforced by test/db/migration-0016.test.ts:
  //
  //   class NULL, reason NULL      NOBODY ASKED. No pass ever ran over this
  //                                crawl (a crawl written before 0016, one that
  //                                failed before the pass), or the pass was
  //                                cancelled before it reached this row.
  //                                NOTHING WAS DECIDED — and emphatically not
  //                                "the page is fine": `http.server-error`
  //                                keeps firing at `critical` on such a row and
  //                                its evidence says `recheck: "not run"`.
  //   class NULL, reason non-null  THE PASS DECIDED NOT TO ASK, AND SAYS WHY.
  //                                One reason at launch, `recheck-cap`, on the
  //                                `RESOURCE_CAP_REASON` doctrine.
  //   class non-null               A SECOND OBSERVATION EXISTS — or a request
  //                                our own policy or robots refused, which is
  //                                `disallowed` plus a reason: a refusal is a
  //                                DECIDED outcome, not an absence.
  //
  // A recheck that itself FAILS is never a null here: `fetchPage` classifies a
  // timeout as `timeout` and a DNS/socket failure as `network_error`, and both
  // are written as the classes they are (hard rule 7).
  //
  // The pass reads the null as its WORK LIST (`fetch_class = 'server_error' and
  // recheck_fetch_class is null`), which is what makes an interrupted pass
  // resumable by re-running it — and what makes a capped row, still null, get
  // picked up by the resume that overwrites its reason.
  recheckFetchClass: text("recheck_fetch_class"),
  // The status the second observation got, or null when there was no response
  // at all (timeout, refused connection, a request never made).
  recheckStatusCode: integer("recheck_status_code"),
  // Why, in the fetch layer's own words — `pages.fetch_reason`'s twin, and null
  // on a recheck that simply worked. Also the column that carries `recheck-cap`
  // while the class stays null, which is the second row of the table above.
  recheckReason: text("recheck_reason"),
  // When the pass SETTLED this row. MOVES WITH `recheck_fetch_class`: the
  // invariant `recheck_at IS NULL` <=> `recheck_fetch_class IS NULL` holds over
  // the whole table, and it is asserted rather than assumed. A `recheck-cap`
  // row is not settled, so it carries a reason and no time.
  recheckAt: timestamp("recheck_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("pages_crawl_url").on(t.crawlId, t.url),
  index("pages_crawl_normalised").on(t.crawlId, t.urlNormalised),
  index("pages_crawl_type").on(t.crawlId, t.pageType),
  // The rule runner's page cursor: `where crawl_id = $1 and id > $2 order by
  // id limit 500`. Without this the runner sorts the crawl's whole page set
  // once per batch, which is the memory contract's cost moved into Postgres.
  index("pages_crawl_id").on(t.crawlId, t.id),
  // The simhash bands `content.near-duplicate` joins on: four 16-bit slices of
  // the signed simhash, each one an expression index so the pair join's
  // `(a.simhash >> k) & 65535 = (b.simhash >> k) & 65535` can be answered from
  // an index instead of by examining every pair. Measured on 5,000 pages: 2.9s
  // without them (nested loop, quadratic), 0.11s with them (BitmapOr across all
  // four arms).
  //
  // TEXTUAL COUPLING, and it is not a soft one. Postgres matches an expression
  // index by comparing the expression's parse tree with the query's, so:
  //
  //  - band 0 MUST be written `(simhash >> 0) & 65535`, exactly as the rule
  //    writes it. `int8shr(simhash, 0)` is NOT constant-folded away, so an
  //    index on the simpler `simhash & 65535` does not match the rule's band-0
  //    predicate and that arm falls back to a sequential scan;
  //  - one arm that fails to match kills the WHOLE BitmapOr — Postgres cannot
  //    use indexes for an OR unless every branch is indexable — and it does so
  //    silently, as a slow query rather than an error.
  //
  // So these four expressions and the four band predicates in
  // `nearDuplicateFindings` (src/rules/query/content.ts) must stay spelled
  // identically. Change one, change the other, and re-check with EXPLAIN.
  index("pages_simhash_band0").on(t.crawlId, sql`((${t.simhash} >> 0) & 65535)`),
  index("pages_simhash_band1").on(t.crawlId, sql`((${t.simhash} >> 16) & 65535)`),
  index("pages_simhash_band2").on(t.crawlId, sql`((${t.simhash} >> 32) & 65535)`),
  index("pages_simhash_band3").on(t.crawlId, sql`((${t.simhash} >> 48) & 65535)`),
  // And the same four bands over `main_simhash` (migration 0019). Phase 19 moved
  // `content.near-duplicate` off the whole-page fingerprint and onto the
  // main-content one — the whole-page value on a templated site measures the
  // header, nav and footer, so unrelated pages landed inside the 3-bit
  // threshold — and the four indexes above cover `simhash` and only `simhash`.
  // Without these the rule's band predicates match nothing, the BitmapOr
  // collapses, and the pair join degrades to the quadratic nested loop the
  // measurement above prices at ~2.9s per 5,000 pages against ~0.11s.
  //
  // The TEXTUAL COUPLING written above applies here word for word, against
  // `nearDuplicateFindings` (src/rules/query/content.ts) rather than against a
  // rule that no longer reads `simhash`: band 0 must stay `(main_simhash >> 0)
  // & 65535` because `int8shr(x, 0)` is not folded away, and one arm that fails
  // to match takes the whole BitmapOr with it, silently.
  //
  // `test/db/migration-0019.test.ts` is what holds the two spellings together:
  // it reads the four predicates out of the rule's own source, compares them
  // with the four `pg_indexes` definitions, and EXPLAINs the real pair query to
  // prove the four `Bitmap Index Scan`s are in the plan.
  index("pages_main_simhash_band0").on(t.crawlId, sql`((${t.mainSimhash} >> 0) & 65535)`),
  index("pages_main_simhash_band1").on(t.crawlId, sql`((${t.mainSimhash} >> 16) & 65535)`),
  index("pages_main_simhash_band2").on(t.crawlId, sql`((${t.mainSimhash} >> 32) & 65535)`),
  index("pages_main_simhash_band3").on(t.crawlId, sql`((${t.mainSimhash} >> 48) & 65535)`),
  // The three duplicate rules' group aggregate and its sample lateral
  // (`groupFindings`, src/rules/query/field-duplicates.ts): `group by
  // btrim(<field>)` over the indexable cohort, then one `where btrim(<field>)
  // = <value> order by url limit 20` lookup per surviving group. Measured on
  // the Phase 8 gate's 20k-page shape at 10.4 ms PER GROUP; capped at 200
  // groups that is 2s a rule, and an uncapped run makes the group count the
  // site's rather than the cap's (gate doc §15, the Phase 9 migration ledger).
  // The column order is the query's: `crawl_id` equality, then the grouped
  // expression, then `url` so the lateral's `order by p2.url limit 20` is read
  // off the index instead of sorted.
  //
  // PARTIAL, and the predicate is the SAME TEXTUAL COUPLING the simhash bands
  // above carry, with a second edge. Postgres uses a partial index only when
  // it can PROVE the query's WHERE implies the index's, so this predicate
  // mirrors `INDEXABLE` (src/rules/query/field-duplicates.ts) VERBATIM —
  // `fetch_class = 'ok' and status_code = 200 and is_indexable = true`. Widen
  // the rule's cohort without widening these and the planner silently stops
  // using them: a slow query, never an error. The trailing `<field> is not
  // null` is implied on the rule's side by `btrim(<field>) = …` and by its own
  // `is not null`, and it is what keeps the index off the rows that can never
  // group. Change one file, change the other, and re-check with EXPLAIN.
  index("pages_dupe_title")
    .on(t.crawlId, sql`btrim(${t.title})`, t.url)
    .where(sql`${t.fetchClass} = 'ok' and ${t.statusCode} = 200 and ${t.isIndexable} = true and ${t.title} is not null`),
  index("pages_dupe_meta_description")
    .on(t.crawlId, sql`btrim(${t.metaDescription})`, t.url)
    .where(sql`${t.fetchClass} = 'ok' and ${t.statusCode} = 200 and ${t.isIndexable} = true and ${t.metaDescription} is not null`),
  index("pages_dupe_h1_text")
    .on(t.crawlId, sql`btrim(${t.h1Text})`, t.url)
    .where(sql`${t.fetchClass} = 'ok' and ${t.statusCode} = 200 and ${t.isIndexable} = true and ${t.h1Text} is not null`),
]);

export const links = pgTable("links", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  sourcePageId: text("source_page_id").notNull(),
  targetUrl: text("target_url").notNull(),
  targetPageId: text("target_page_id"),
  anchor: text("anchor"),
  rel: text("rel"),
  isInternal: boolean("is_internal").notNull(),
  isNofollow: boolean("is_nofollow").notNull().default(false),
  position: integer("position").notNull(),
}, (t) => [
  index("links_crawl_target_url").on(t.crawlId, t.targetUrl),
  index("links_crawl_target_page").on(t.crawlId, t.targetPageId),
  index("links_crawl_source").on(t.crawlId, t.sourcePageId),
]);

export const hreflang = pgTable("hreflang", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull(),
  hreflangCode: text("hreflang_code").notNull(),
  targetUrl: text("target_url").notNull(),
  targetPageId: text("target_page_id"),
  source: text("source").notNull(), // html|sitemap|header
}, (t) => [index("hreflang_crawl_page").on(t.crawlId, t.pageId),
           index("hreflang_crawl_target").on(t.crawlId, t.targetUrl)]);

export const structuredData = pgTable("structured_data", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull(),
  schemaType: text("schema_type").notNull(),
  raw: jsonb("raw_jsonb").notNull(),
  fieldPresence: jsonb("field_presence_jsonb"),
}, (t) => [
  index("sd_crawl_type").on(t.crawlId, t.schemaType),
  // COUPLED to `deriveFieldPresence`'s batch query (src/rules/derive/field-presence.ts),
  // which streams the crawl's blocks by a `page_id` cursor: `where crawl_id = $1
  // and page_id > $cursor … order by page_id limit N`. Without this index every
  // batch rescans every profiled row of the crawl and the derivation is
  // quadratic in the number of pages carrying structured data — a slow query,
  // never an error, which is exactly the failure that hides. Change the cursor
  // there, change this index here (the `pages_simhash_band*` precedent).
  index("sd_crawl_page").on(t.crawlId, t.pageId),
]);

/**
 * ONE ROW PER DISTINCT RESOURCE URL PER CRAWL — the images, stylesheets and
 * scripts the crawled pages point at (P11-T1, migration 0013). The per-page
 * fan-out lives next door in `page_resources`; this table is about FILES, and
 * the split is what makes "one image referenced by 400 pages" one fetch and one
 * row rather than 400 of each.
 *
 * The crawl path (`PageWriter`) writes `crawl_id` / `url` / `kind` and NOTHING
 * ELSE: every other column is the resource fetch pass's (P11-T2), and until it
 * has run they are all null. Dedup is this table's job and not the writer's —
 * the unique index below plus `on conflict do nothing`, never a set of URLs in
 * memory (hard rule 6).
 *
 * THESE ARE THE SERVED HTML'S REFERENCES, and the qualification is not a
 * footnote. The render pass runs the same analyzer over the post-JavaScript DOM
 * and its resource refs are DELIBERATELY DISCARDED (P11-T1), so assets a
 * client-rendered site injects at runtime are not in this table. On such a site
 * an empty result here means "the server sent no references", which is a
 * different sentence from "this page loads no assets" — and a rule that read the
 * two as one would be a rule that always passes (hard rule 1). Any consumer
 * reporting resource coverage says which of the two it is looking at.
 */
export const resources = pgTable("resources", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  // THE RESOURCE'S IDENTITY, and the decision behind the spelling (P11-T1):
  // this is `normalizeUrl(raw, pageUrl)` output — absolute, http(s) only,
  // fragment stripped, query params sorted, hostname lowercased — which is the
  // SAME function the frontier keys `pages.url` by and the link extraction
  // resolves against. One resolution semantics for everything this engine
  // fetches, so a URL cannot mean one thing on the page side and another here.
  //
  // It is therefore BOTH the dedup key and the URL the fetch pass will request,
  // which is why nothing further is folded into it. In particular the PATH KEEPS
  // ITS CASE: `pages.url_normalised` lowercases because it is an analytic
  // variant key that is never fetched, and a lowercased CDN path is a 404.
  //
  // There is deliberately NO second `url_normalised` column here. `pages` needs
  // two spellings because its duplicate-URL checks group case/slash variants of
  // one page; no rule asks that question of a resource, and a column nobody
  // reads is a column that silently rots.
  url: text("url").notNull(),
  // image|css|js — `ResourceKind` in src/crawl/parse/page-analyzer.ts is the
  // authority; this comment tracks it. Free text, no enum constraint, on the
  // `crawls.status` precedent: adding a class is a code change, and every
  // consumer is audited by hand when one is added. The class is the one the
  // MARKUP declared (an `<img src>` is an image), never the served
  // content-type — which the fetch pass records separately and which
  // disagreeing with this is itself an audit finding.
  kind: text("kind").notNull(),
  // ok|client_error|server_error|fetch_error|refused|robots_denied — the page
  // vocabulary plus the two a resource can earn (P11-T2).
  //
  // NULL MEANS "SEEN, NOT YET ASKED", and it is the null-vs-zero doctrine's
  // newest citizen: the analyzer found this reference and no fetch has been
  // attempted — because the pass has not run yet, was interrupted, or a cap
  // stopped short of this row (in which case `fetch_reason` says so). It is NOT
  // "the fetch failed", which is `fetch_error`, and it is NOT "the resource is
  // fine", which is `ok`. Every rule that judges a resource must gate on this
  // column being non-null: an unfetched resource is UNKNOWN, never broken
  // (hard rules 1 and 7). The fetch pass reads the null as its work list, which
  // is what makes an interrupted pass resumable by re-running it.
  fetchClass: text("fetch_class"),
  // Why, in the fetch layer's own words: the policy's refusal, the robots rule,
  // `resource-cap` for a row a resource cap stopped at — a budget granted per
  // RUN, not per crawl, so a resume re-grants it and may clear this reason off
  // rows an earlier run wrote it on. `pages.fetch_reason`'s twin, and null on a
  // fetch that simply worked.
  fetchReason: text("fetch_reason"),
  statusCode: integer("status_code"),
  contentType: text("content_type"),
  // The transferred size in bytes, from `content-length` or from counting a
  // discarded body; `bytes_source` says which, because a header is a claim and
  // a count is a measurement and the weight rules quote both.
  bytes: integer("bytes"),
  // header|counted. Null while `bytes` is null — the pair moves together.
  bytesSource: text("bytes_source"),
  // The two cache headers verbatim, for the caching rule (P11-T3). Null after a
  // successful fetch means the server sent none, which is the finding; null
  // before one means nothing was asked, which is `fetch_class` null's business.
  cacheControl: text("cache_control"),
  expires: text("expires"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  // NOT A RESPONSE TIME. Measured from the top of the row's work, which is
  // before `gate.acquire`, so it carries the row's wait for its host's turn as
  // well as the request: on a spacing-dominated crawl this reads as roughly the
  // per-host delay, not as what the server took (P11 gate §2.2 measured p50
  // 3,990 ms at a 2,000 ms spacing). `pages.response_time_ms` is the other
  // shape — the request alone.
  fetchMs: integer("fetch_ms"),
}, (t) => [
  // The dedup, and the upsert target. One row per URL per crawl: the writer
  // inserts with `on conflict do nothing`, so the second page to reference an
  // image adds an edge and no row.
  uniqueIndex("resources_crawl_url").on(t.crawlId, t.url),
]);

/**
 * WHICH PAGE REFERENCES WHICH RESOURCE — the per-page fan-out `resources`
 * deliberately does not carry (P11-T1, migration 0013).
 *
 * Two pages sharing an image are two rows here and one row there. The edge is
 * keyed by the resource's URL rather than by a surrogate id for the reason
 * `PageWriter` mints its own `page_id`: the writer must be able to build a
 * child row without reading anything back, and `(crawl_id, url)` already
 * identifies the resource.
 *
 * ONE CAVEAT THE WEIGHT NUMBERS INHERIT, and it belongs here because this table
 * is what a rollup joins through. An `<img>` carrying BOTH `src` and `srcset`
 * contributes both URLs (the fallback and the first rendition — two real files,
 * and 0013 carries no column saying which a given client would pick), so on a
 * responsive site the edges over-count what any ONE browser downloads, roughly
 * two-fold on such images. A page-weight sum over these edges is therefore a
 * CEILING, and P11-T3's `page.weight` metric must say so in its copy — the upper
 * bound stated alongside the `atLeast` floor that unfetched resources impose.
 * Two honest bounds around a number nobody can measure exactly from markup, not
 * one number pretending to be the answer.
 *
 * NO FOREIGN KEY to `pages` or to `resources`, matching `links`, `hreflang` and
 * `structured_data`, and for a concrete reason rather than by imitation: page
 * ids are minted before the insert and a page row that loses the
 * `(crawl_id, url)` conflict leaves children pointing at an id no row carries
 * (see PageWriter's header), and the resource rows are inserted in a separate
 * batch from the edges, so an FK would turn batch ordering into a hard failure.
 * The cascade that matters — deleting a crawl — is the `crawl_id` FK, which
 * both tables carry.
 */
export const pageResources = pgTable("page_resources", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  pageId: text("page_id").notNull(),
  // The `resources.url` spelling — normalizeUrl output, see that column.
  resourceUrl: text("resource_url").notNull(),
}, (t) => [
  // "What does this page reference" (the per-page weight rollup) and "who
  // references this file" (the referencing-page count the resource rules
  // report), which are the only two directions anything asks. The `links`
  // precedent: source index and target index, both.
  index("page_resources_crawl_page").on(t.crawlId, t.pageId),
  index("page_resources_crawl_resource").on(t.crawlId, t.resourceUrl),
]);

export const sitemapUrls = pgTable("sitemap_urls", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  // The `<loc>` as the site published it, resolved to absolute and no further.
  // It stays the primary key and the evidence: the report quotes it because it
  // is the line of XML somebody edits.
  url: text("url").notNull(),
  // The same entry put through `normalizeUrl` — fragment stripped, query
  // parameters sorted — which is the spelling `pages.url` is keyed by, and
  // therefore the only spelling that can join the two tables. A `<loc>`
  // reading `/x?b=2&a=1#top` and the page row the crawl created from it
  // (`/x?a=1&b=2`) are one URL, and this column is where they meet.
  //
  // NOT NULL with an empty-string default, which is for rows written before
  // this column existed and for nothing else: the writer always computes a
  // value (and throws if it cannot). An empty string is therefore UNAMBIGUOUS
  // — `normalizeUrl` returns at least `scheme://host/` for every URL it
  // accepts, so no crawl can ever write one — and it is detected and refused,
  // not tolerated (`assertNormalisedSitemap`, src/rules/query/crawl-evidence.ts).
  //
  // Refused rather than tolerated because such a row is not quietly inert: it
  // fails the join, and the rules that fire ON a failed match then fire on
  // everything. `sitemap.uncrawled` reports every entry as a URL the crawl
  // never reached, `pages.not-in-sitemap` reports every indexable 200 (its
  // data gate only asks that the crawl HOLD sitemap rows, which it does),
  // `links.orphan` calls every orphan `inSitemap: false`, and
  // `robots.blocks-sitemap-urls` goes silent about a sitemap it never checked.
  // Maximal noise plus one false all-clear — worse than the pre-switch
  // behaviour, under which almost every row joined.
  //
  // So a pre-Phase-4 crawl is NOT a supported re-judge target: re-crawl the
  // site. Same ruling and same reason as a null `discovery_jsonb`, which the
  // rules refuse rather than judge a site on evidence that is not there
  // (`parseDiscovery`, same file).
  urlNormalised: text("url_normalised").notNull().default(""),
  sitemapSource: text("sitemap_source").notNull(),
  lastmod: text("lastmod"),
  pageId: text("page_id"),
}, (t) => [
  primaryKey({ columns: [t.crawlId, t.url] }),
  // The join column of five rules (the four sitemap ⋈ pages rules and
  // `pages.not-in-sitemap`'s anti-join, plus `links.orphan`'s membership test).
  // The primary key served those joins while they matched on `url`; this index
  // is what keeps a 50k-entry sitemap off a sequential scan now that they match
  // on the normalised spelling.
  index("sitemap_urls_crawl_normalised").on(t.crawlId, t.urlNormalised),
]);

export const urlParams = pgTable("url_params", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  paramName: text("param_name").notNull(),
  occurrenceCount: integer("occurrence_count").notNull(),
  sampleUrls: text("sample_urls").array().notNull(),
  isTracking: boolean("is_tracking").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.crawlId, t.paramName] })]);

export const issues = pgTable("issues", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  pageId: text("page_id"),
  severity: text("severity").notNull(), // critical|warning|info
  // The ruleset that produced this row. Defaulted rather than backfilled: the
  // empty string is honestly "written before the stamp existed", where a
  // backfilled version number would be a claim about which rules ran that
  // nobody can check.
  rulesetVersion: text("ruleset_version").notNull().default(""),
  dedupeKey: text("dedupe_key").notNull(),
  details: jsonb("details_jsonb").notNull(),
}, (t) => [uniqueIndex("issues_dedupe").on(t.crawlId, t.ruleId, t.dedupeKey),
           index("issues_crawl_rule").on(t.crawlId, t.ruleId)]);

export const metrics = pgTable("metrics", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  metricId: text("metric_id").notNull(),
  // site|page_type|sitemap_doc — `MetricScope` in src/rules/registry/types.ts,
  // which is what the runner validates a metric rule's rows against. A free
  // text column here; the closed set lives there.
  scope: text("scope").notNull(),
  scopeValue: text("scope_value").notNull().default(""),
  value: jsonb("value_jsonb").notNull(),
}, (t) => [primaryKey({ columns: [t.crawlId, t.metricId, t.scope, t.scopeValue] })]);

export const frontier = pgTable("frontier", {
  crawlId: text("crawl_id").notNull().references(() => crawls.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  // pending|leased|done|failed|render_pending — the first four are the crawl
  // pass's, `render_pending` is the render pass's (a `done` row the render
  // selection promoted; it goes back to `done` once rendered). See
  // src/crawl/frontier.ts, which is the authority on the state machine.
  state: text("state").notNull().default("pending"),
  depth: integer("depth").notNull(),
  discoveredVia: text("discovered_via").notNull(),
  attempts: integer("attempts").notNull().default(0),
  leaseId: text("lease_id"),
  leasedUntil: timestamp("leased_until", { withTimezone: true }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.crawlId, t.url] }),
  index("frontier_leasable").on(t.crawlId, t.state, t.leasedUntil),
]);

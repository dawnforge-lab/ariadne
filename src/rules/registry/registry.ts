import { metricTableColumns, metricTableSummary, RESERVED_TABLE_KEYS } from "./metric-table.js";
import type { AnyRule } from "./types.js";
export * from "./metric-table.js";
export * from "./types.js";

export class RuleDefinitionError extends Error {
  // Explicit so the name survives transpilation and minification: callers that
  // cannot `instanceof` across module boundaries match on `error.name`.
  override name = "RuleDefinitionError";
}

const RULE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CHECK_ID = /^CHECK-\d{2}[a-z]?$/;
/**
 * The rule kinds `defineRule` accepts. `satisfies` ties the list to the type:
 * a misspelled or retired kind here stops compiling rather than becoming a
 * value no rule can ever have. The `.includes` call below widens it back to
 * `string`, because the value being validated arrives from JavaScript that the
 * type system did not check.
 */
const KINDS = ["page", "query", "metric"] as const satisfies readonly AnyRule["kind"][];

/**
 * The version stamped on every rule and on the `crawls` row. Bump it whenever a
 * rule's verdict or copy changes, so a finding can be traced to the ruleset
 * that produced it. One constant — `loop.ts` imports it rather than restating.
 */
// 0.15.0: Phase 20, the reports-and-copy pass
// (docs/superpowers/specs/2026-09-10-reports-and-copy-design.md), on THREE
// grounds. (1) COPY: every rule's title, explanation and howToFix rewritten by
// hand in the register of an SEO tool ("Area: Condition", one to three
// sentences, an imperative fix) and every marker reason as one sentence; the
// rubric in test/rules/copy.test.ts pins the shape and the accuracy claims.
// (2) REPORT COLUMNS: every rule that finds declares `columns` — the evidence
// fields a reader sees and the heading each is printed under — served by
// rules_catalog and by every listing beside the four standard columns
// (Address, Status Code, Indexability, Indexability Status) derived from the
// page row. (3) EVIDENCE: crawl.blocked gains fetchReason. No verdict,
// severity or finding moves; an older crawl re-judged at 0.15.0 reports the
// same rows under the new headings. The T1 note that follows records the
// mechanics.
//
// Phase 20 T1, the mechanics behind ground (2) and (3):
//
//  1. EVERY RULE THAT FINDS NOW DECLARES ITS REPORT. `RuleMeta.columns`
//     (`ReadonlyArray<{key, label, optional?}>`) names the evidence fields a
//     reader sees and the heading each is printed under — Screaming Frog's
//     vocabulary where one exists (`Status Code`, `Inlinks`, `Title 1`,
//     `Title 1 Length`, `Word Count`, `No. Near Duplicates`, `Closest Near
//     Duplicate Match`, `Canonical Link Element`, `Meta Robots`, `hreflang`,
//     `Expected Link`, `URL Not Returning Link`, `Source`, `Anchor`). All 86
//     non-metric rules carry one; `defineRule` requires the field and refuses it
//     on a metric rule. THIS IS COPY A CLIENT READS, which is why it is a
//     ground: `rules_catalog` serves the column labels the same way it serves a
//     title, so what the ruleset SAYS about a site changed even where no verdict
//     did. Three rules declare an EMPTY list — `canonical.missing`,
//     `mobile.viewport-missing`, `pages.not-in-sitemap` — because their report
//     is the four standard columns and nothing else, and inventing a fifth would
//     put a heading over a column the rule cannot honestly fill.
//
//  2. ONE RULE'S EVIDENCE SHAPE CHANGED. `crawl.blocked` gains `fetchReason`,
//     the sentence `pages.fetch_reason` holds: the standard columns already say
//     the URL, the status and "Non-Indexable / Blocked by bot protection", and what they
//     cannot say is WHICH wall this was — a `cf-mitigated` header, a 401/403/429,
//     a challenge body on a 503. That is the difference between "allowlist our
//     user agent" and "this URL is behind a login". No other rule's evidence
//     moved: the §2.3 gaps the design named (`sitemap.non-indexable`'s reason,
//     the title/meta/H1 text and lengths, `links.orphan`'s `discoveredVia`,
//     `structure.deep-page`'s `clickDepth`, the images' resource and bytes) were
//     already carried, and the sitemap one is given for free by the standard
//     columns.
//
//  3. NOTHING ELSE. No verdict moves, no severity moves, no finding appears or
//     disappears, and no other evidence key is added or removed. A crawl
//     re-judged at the bumped version produces the same findings with the same
//     evidence, plus `fetchReason` on any `crawl.blocked` row.
//
// (`saysNoindex` / `hasNoindex` moved from src/rules/page/indexability.ts to
// src/rules/helpers.ts, which re-exports nothing to the wire and changes no
// verdict — noted only so a reader of the diff is not looking for a fourth
// ground.)
//
// 0.14.0: Phase 19, the audit accuracy pass
// (docs/superpowers/specs/2026-09-09-audit-accuracy-pass-design.md), on FOUR
// grounds. (1) Verdicts MOVED: `content.exact-duplicate` and
// `content.near-duplicate` no longer count a page canonicalised elsewhere, and
// every hreflang rule ignores such a page as declarer and as target — two
// parameter variants on a real crawl were reported critical for the state the
// fix text prescribes. (2) A measurement CHANGED: `content.near-duplicate`
// pairs on `main_simhash` (the fingerprint of the main content, migration
// 0018) with both pages at least 50 words of their own, instead of the
// whole-text `simhash` that ~900 words of chrome dominated; on a crawl with no
// main-content fingerprint the rule is silent and `content.near-duplicate-
// skipped` says why. (3) Rules ADDED: `links.to-server-error` (critical),
// `hreflang.missing-self-reference` (warning), and two NOT MEASURED markers,
// `hreflang.alternates-not-crawled` and `content.near-duplicate-skipped`
// (info). 100 rules: 28 critical / 25 warning / 47 info. (4) COPY changed on
// 26 rules and every marker reason, under the rubric test in
// test/rules/copy.test.ts; `content.placeholder`'s evidence gains the snippet.
// Nothing is backfilled: an older crawl re-judged at 0.14.0 loses the
// canonical-variant duplicates (they were never duplicates), gains the two
// markers where they apply, and keeps every other finding.
//
// AMENDED AT GATE TIME (spec §11), after a re-crawl at 0018 showed the theme
// putting its footer INSIDE `<main>`. Two more facts about what 0.14.0 says,
// both inside the same version because none of it has shipped:
//  (5) `content.near-duplicate` reports one finding per PAGE, not per pair:
//      `{mainWords, nearDuplicates, closest: [{url, hamming, mainWords}]}`, up
//      to five closest, capped by pages with an exact total. The 500-pair
//      budget and the 100,000-pair scan ceiling are gone with the unit — the
//      partners are now counted inside Postgres — so `findingCap` governs one
//      listing budget instead of three, and a cluster of 79 empty templates is
//      79 rows rather than 500 arbitrary pairs out of 3,081. `nearDuplicates`
//      is exact up to 200 and a stated floor above it (`nearDuplicatesAtLeast:
//      true`): counting past 200 partners per page is what made the wall clock
//      quadratic on a degenerate cohort, and no reader needs the difference
//      between 200 and 3,000 to reach the same verdict about the template.
//  (6) `content.thin` fires on `main_word_count < 150` — the words a page has
//      of its OWN — instead of `renderable_word_count`, and is a QUERY rule
//      where it was a page rule (with its marker `content.thin-skipped`, now
//      site-scoped too): the column's null means "no main content at all" on a
//      0018 crawl and "never measured" on an older one, and only the crawl's
//      census tells those apart. A page with no content of its own is reported
//      as zero words rather than passed over. The kind change moves the
//      ruleset split to 25 page / 61 query / 14 metric over the same 100 rules,
//      and no severity, category or check claim moves with it. On the crawl
//      behind the phase this rule fired on nothing while 35 pages had under
//      150 words of their own; that is the always-passes shape hard rule 1
//      forbids, and the column was what was wrong with it.
//
// 0.13.0: Phase 17, on THREE grounds — one rule added, one verdict MOVED, and
// copy changed. The 5xx re-verification pass
// (docs/superpowers/specs/2026-09-08-5xx-recheck-design.md) fetches every
// `server_error` page exactly once more at crawl end and writes the second
// observation beside the first, and the ruleset now reads it:
//
//  1. `http.server-error-transient` (warning), a verdict no page could receive
//     before: a 5xx whose second look got a non-5xx answer FROM THE SITE.
//  2. `http.server-error` no longer fires on those pages. That is the verdict
//     MOVE, and the only one: a page that was `critical` at 0.12.0 is a
//     `warning` at 0.13.0 when — and only when — a recheck cleared it. The two
//     rules are mutually exclusive and jointly exhaustive over
//     `fetch_class = 'server_error'`, so no 5xx page goes silent.
//  3. `http.server-error`'s explanation and howToFix, reworded to name the
//     second observation and to say plainly that a finding whose `recheck` is
//     "not run" has not been re-verified. Both rules' evidence carries the
//     recheck columns.
//
// Totals move to 27 critical / 24 warning / 45 info over 96 rules.
//
// THE MIGRATION STORY, because this is the first bump that could have lost an
// Error and does not: NOTHING IS BACKFILLED. The recheck columns are null on
// every row written before migration 0016, and `recheckCleared` is false on a
// null class, so an older crawl re-judged at 0.13.0 reports exactly what it
// reported at 0.12.0 — every Error still an Error — with `recheck: "not run"`
// added to the evidence saying why it was never re-verified. A finding moves
// band only on a crawl that actually took a second look and got an answer.
//
// 0.12.0: Phase 16, on ONE ground — a severity recalibration, and nothing else.
// 29 of the 95 rules move band: 23 from `warning` to `critical`, 5 from
// `info` to `warning`, and `crawl.blocked` from `warning` to `info` as the tenth
// NOT MEASURED marker (owner-ruled: a crawl refusal is a fact about our crawl,
// not a site issue), leaving 27 critical / 23 warning / 45 info. The rules,
// the rubric they were classified against and the per-rule rationale are
// docs/superpowers/specs/2026-09-08-severity-recalibration-design.md §1-3;
// that document's §3 is the authority for which ids moved.
//
// This is the cleanest bump the file has had, and the property worth stating is
// what it does NOT change: no finding's existence and no finding's evidence. The
// same crawl re-judged at 0.12.0 produces the identical set of findings, with the
// `severity` column of those 29 rules' rows moved and every other column — id,
// scope, url, evidence, copy — byte-identical. No rule was added, retired,
// rewritten or rescoped; the one copy edit is `crawl.blocked`'s title and
// explanation, reworded to say it is a crawl outcome rather than a defect.
//
// It is still a bump, because the version stamps what the ruleset SAYS about a
// site and this changes that: a crawl judged at 0.11.0 and one judged at 0.12.0
// are not row-comparable on severity, and anything rolled up FROM severity moves
// with them. `site.health`'s `urlsCritical` is the one to watch — it meant
// "pages that are mechanically broken" at 0.11.0 and means "pages carrying a
// first-fix SEO defect" at 0.12.0, so a gauge drawn from it needs the ruleset
// version beside the number. Stored findings keep the severity their ruleset
// gave them; nothing is backfilled, which is what `test/api/query.test.ts`'s
// cross-ruleset machinery exists to report.
//
// 0.11.0: Phase 14 Task 1, on ONE ground. `resources.partial-unknown` (T1), the
// fourth and last resource marker. A crawl whose census is a MIX — some rows
// `null` (never asked about), the rest a decided unknown class (`refused`,
// `robots_denied`, `robots_unreachable`, `fetch_error`), and not one `ok` or
// broken row — met NO finding at all: the four judging rules gate on an `ok`
// class and go quiet, `resources.broken` has no broken row, and the three
// existing markers exclude it by construction (`seen == 0`, every row null,
// every row a decided unknown — this is the mix none of them match). It closes
// the window phase-13.md §8 pointer 1 named, one layer in from the §10.1 window
// `resources.all-unknown` closed. ADDITIVE by the same argument all three
// siblings are — a crawl gains a finding it could not receive before, no existing
// verdict moves — which is why the bump belongs here. No copy of any existing
// rule changed.
//
// 0.10.0: Phase 13 Task 2, on ONE ground. `resources.all-unknown` (T2), the
// third and last resource marker. A crawl whose every resource row landed in an
// unknown class — `refused`, `robots_denied`, `robots_unreachable`,
// `fetch_error`, and not one `ok` or broken or unasked row — met NO finding at
// all: the four judging rules gate on an `ok` class and go quiet, the two
// existing markers exclude it by construction (their conditions are `seen == 0`
// and `null == seen`), and a re-judge at 0.10.0 gives that crawl a marker. It is
// ADDITIVE by the same argument its two siblings are — a crawl gains a finding
// it could not receive before, no existing verdict moves — which is why the bump
// belongs here rather than being a change a stored finding already carries. It
// closes the window Phase 12 stated and left open (docs/gates/phase-12.md
// §10.1): the closure named "another marker, another rule, another bump", and
// this is that bump. No copy of any existing rule changed.
//
// 0.9.0: Phase 12, on three grounds — and ALL are named because this constant
// stamps more than a verdict. The paragraph above is the contract: a finding is
// traced to the ruleset that produced it, and `rules_catalog` serves the COPY
// stamped with this same constant, so text a client reads is part of what a
// version identifies.
//
//  1. `resources.not-fetched` (T2). A marker a crawl could not receive before: a
//     crawl that recorded every file its pages point at and asked about none of
//     them — `fetchResources: false`, a pass interrupted before its first
//     request, or a `maxResources` budget that claimed every row before anything
//     was asked — met no finding at all, and a re-judge at 0.9.0 gives it one. It
//     is ADDITIVE by construction: the sibling the Phase 11 gate ruled on
//     (docs/gates/phase-11.md §10.3), never a widened `resources.not-recorded`,
//     whose condition moving would have been a verdict change on a rule that
//     already exists.
//  2. `resources.broken` and `resources.uncached`'s explanations (T1). Both now
//     name the `robots_unreachable` class the fetch pass writes, in the
//     unknown-bucket sentence a client reads. The verdicts did not move; what
//     the ruleset SAYS did.
//  3. `render.coverage` gained a column and its explanation gained the sentence
//     that reads it (T4): `renderPassEvidence`, which says whether the four
//     recomputed selection numbers describe a decision that was taken or one
//     that would be. A metric's SHAPE changed and so did the copy served with
//     it — the same ground as (2), on the row an auditor reads before quoting
//     any JavaScript finding (docs/gates/phase-11.md §6.3).
//
// ONE BUMP FOR THE PHASE, not one per task: 0.9.0 is stamped by T2 and covers
// every ground above. A crawl re-judged at it gets the marker, the two reworded
// resource explanations and the new coverage column together.
//
// 0.8.0: Phase 11. Five verdicts a page or a site could not receive before —
// `resources.broken`, `images.oversized`, `images.legacy-format`,
// `resources.uncached` and the `resources.not-recorded` marker — plus the
// `page.weight` table. They read `resources` and `page_resources`, which
// migration 0013 created and the resource fetch pass fills, so a crawl re-judged
// at 0.8.0 can gain findings it did not have and a crawl from before 0013 gains
// the marker saying why it cannot.
//
// 0.7.0: `structure.deep-page` moved to `click_depth` — a rule silent on real
// sites became reachable, so a re-judged crawl can change verdict.
//
// ---------------------------------------------------------------------------
// 0.16.0: Phase 21, on ONE ground. The metric tables pass
// (docs/superpowers/specs/2026-09-11-metric-tables-design.md) gives every metric
// rule a `table` declaration — the shaper that turns its stored rows into rows,
// and a LABEL over every column and every summary scalar. No metric's stored
// value, predicate or copy moves: a crawl re-judged under the bumped version
// writes byte-identical `metrics` rows. The ground is the labels themselves.
// They are client-facing text — `rules_catalog` serves them beside a title, the
// `metric_table` route and the `metric_table` CSV print them as headings — so
// what the ruleset SAYS about a site changed exactly as ground (2) of 0.15.0
// changed it for the finding rules' column headings. One ground, stated here so
// the version can be traced to it. The declaration also carries `table.order` —
// where the metric sits in the metric section — which is a presentation
// decision rather than a sentence, and rides on the same bump rather than
// earning one of its own.
// ---------------------------------------------------------------------------
// 0.17.0: Phase 22, the judged cohort. Grounds as T1 recorded them:
// the judged cohort (docs/superpowers/specs/2026-09-23-judged-cohort-design.md).
// Three grounds, all of ground (2)'s family — what the ruleset SAYS about a site
// changes on a re-judge, with no migration and nothing backfilled:
//
//  1. 26 rules narrowed their cohort to the JUDGED page (fetched OK, 200,
//     indexable, NOT canonicalised elsewhere — `isJudged`/`JUDGED`,
//     src/rules/helpers.ts). Every on-page, technical, content, structured-data,
//     link-graph and sitemap-coverage rule listed in §1 of the spec now says
//     nothing about a page that has handed its signals to another URL or been
//     kept out of the index, so a re-judged crawl LOSES findings — 79 duplicate
//     title groups to 5 on the reference bilingual crawl. `site.health` gains
//     `urlsCanonicalised` and `urlsNoindex` so the loss is a number rather than
//     a silence, and the metrics' shared cohort narrowed with the rules.
//  2. the four duplicate rules collapse reciprocal hreflang alternates into one
//     member (§2): a group's `count` is its distinct clusters, `pages` lists one
//     URL per cluster, and `alternatesCollapsed` is the new evidence key beside
//     them. `content.exact-duplicate` is deliberately NOT collapsed.
//  3. `sitemap.non-indexable` gained a case rather than losing one — a listed
//     URL that canonicalises elsewhere — with a `reason` evidence key and a
//     Reason column, so a re-judged crawl can gain findings there.
//
// Two widenings ride along: `content.soft-404` dropped `is_indexable` (a 200
// that is really a not-found is a fault whatever its directives say), and the
// two page-scoped structured-data rules acquired a page cohort where they had
// none at all.
// ---------------------------------------------------------------------------
// 0.18.0: Phase 23, proven behaviour (docs/research/2026-10-21-screaming-frog-
// study.md; plan docs/superpowers/plans/2026-10-21-phase-23-proven-behaviour.md).
// ONE BUMP FOR THE PHASE, stamped by T2; later tasks append their grounds here.
//
//  1. (T2, study D2) Four fetch outcomes that were classified rows and judged by
//     NO rule now are findings — the silence hard rule 7 forbids. A crawl
//     re-judged at 0.18.0 can GAIN findings, and no existing verdict moves:
//     `http.no-response` (critical) / `http.no-response-transient` (warning)
//     over `timeout` and `network_error` rows, split on the recheck exactly as
//     the 5xx pair is; `page.html-too-large` (critical) over a 200 `too_large`
//     row; and the `crawl.unreadable-encoding` marker over
//     `unsupported_encoding`. The recheck pass now also re-asks the two
//     no-response classes after every 5xx, under their own 100-row cap and a
//     per-host breaker (`host-unresponsive` after 3 consecutive), and
//     `crawl_status.recheck` gained a `noResponse` block. A pre-Phase-23 crawl
//     re-judged here has no recheck on those rows, so its no-response findings
//     say `recheck: not run` and stay critical — the honest reading.
//     The HTML body cap rose from 1 MiB to 2 MiB (`MAX_BODY`), which changes
//     what a NEW crawl reads but no stored verdict.
//  2. (T3, study D1) Internal URLs robots.txt disallows were dropped at enqueue
//     — no row, no finding. The crawl now records each as a `disallowed` page
//     row (never requested; `fetch_reason` = `robots.txt: <matching line>`)
//     under its own budget (`maxBlockedUrls`, default `maxPages`; overflow in
//     `crawls.robots_blocked_dropped`, migration 0020), and
//     `robots.blocks-internal-urls` (warning, CHECK-03) reports each with its
//     inlinks, served by the inlinks report beside the two link rules'. Only a
//     NEW crawl has the rows: a pre-0020 crawl re-judged here has none, so the
//     rule is silent on it and its null overflow count is read as unmeasured.
//     The fetched-page censuses (`redirect.volume`'s denominator,
//     `render.coverage`'s `pagesCrawled`, the render budget) exclude the rows;
//     `site.health` counts them under URLs Not Judged; `sitemap.uncrawled`
//     says `attempted: false` for one; the pagination and hreflang target
//     lookups read one as "never fetched", as the absence of a row was read.
//  3. (T4, study §2) Two thresholds moved to the proven defaults: the title
//     floor 10 -> 30 characters and the meta description ceiling 160 -> 155, so
//     a crawl re-judged at 0.18.0 can GAIN `title.too-short` and
//     `meta-description.too-long` findings. Two info page rules were added,
//     both judged-only: `headings.h1-too-long` (first H1 over 70 characters,
//     CHECK-37) and `url.too-long` (stored URL over 115 characters, CHECK-28).
//  4. (T5, study §4.1) The analyzer now runs the tree builder's head rules
//     over the token stream: the head ends at `</head>`, at `<body>`, at the
//     first element a head does not allow (an `<img>`, a `<div>`, an `<svg>`)
//     or at the first non-whitespace text, and five fields record which head
//     elements came after that point (migration 0021, with `head_closed_by`
//     naming an implicit closer): four first-occurrence flags (the first
//     title, description, robots meta, canonical — the one the value is read
//     from — sits outside) and a count of hreflang alternates outside. Two page rules read them:
//     `head.directives-outside-head` (critical, fetched-OK cohort, CHECK-18 /
//     -04 / -24: canonical, robots or hreflang outside the head) and
//     `head.tags-outside-head` (warning, judged, CHECK-35 / -36: title or meta
//     description outside it). No extracted value moved — the canonical, the
//     robots meta, the title and the hreflang pairs are still the first
//     occurrence anywhere, and whether a canonical outside the head should stop
//     counting is left to an owner ruling. A pre-0021 crawl re-judged here has
//     null flags and both rules are silent on it; a new crawl can GAIN them.
//  5. (T6, study §4.2) The render pass persists three more values from its
//     analysis of the post-JS DOM — `rendered_robots_meta`,
//     `rendered_meta_description`, `rendered_h1_text` — and
//     `rendered_tags_read`, which says this pass read them (migration 0022).
//     Five query rules compare raw with rendered on rendered, fetched-OK pages
//     with no render error and no JavaScript redirect:
//     `render.noindex-changed` and `render.canonical-changed` (critical) and
//     `render.title-changed`, `render.meta-description-changed`,
//     `render.h1-changed` (warning), each claiming CHECK-01 and its element's
//     check. Every finding carries `sampled: true`. A crawl rendered before
//     0022 re-judged here keeps silence on robots, description and H1 (nothing
//     read them) and CAN GAIN title and canonical findings, whose rendered
//     columns Phase 8 already stored.
//  6. (T7, study §4.5) `title.duplicate`, `meta-description.duplicate` and
//     `h1.duplicate-text` leave out judged pages that declare rel=prev (pages
//     2+ of a paginated series), so a crawl re-judged at 0.18.0 can LOSE
//     findings there; no migration. The exclusion is counted:
//     `paginationExcluded` on every finding (a new "Paginated Pages Set Aside"
//     column) and `urlsPaginated` on `site.health`. The content duplicate rules
//     are unchanged.
//  7. (Frontier-stall follow-up) `links.orphan` / `links.orphan-skipped` treat
//     a crawl whose frontier cap turned a new URL away
//     (`crawls.frontier_capped = true`, migration 0023) as capped, whatever its
//     page count: such a crawl can end below `maxPages` with nothing pending
//     and a partial link graph. A NEW crawl re-judged here can therefore LOSE
//     `links.orphan` findings and GAIN the skip (and `structure.deep-page`
//     gains the matching `incompleteCrawl` caveat). A pre-0023 crawl has null
//     in the column, and the page-count test is all it is judged on, as before.
//
// 0.19.0: Phase 25, evidence layer (docs/superpowers/specs/2026-11-04-phase-25-
// evidence-layer-design.md §5). ONE BUMP FOR THE PHASE; later tasks append here.
//
//  8. (T4, closes the Phase 24a "T4" debt) `render.coverage` reads a third
//     `renderPassEvidence` value, `failed`, and a new `renderLaunchError` key,
//     when a render pass could not launch its browser. Before, the selection a
//     failed launch left `render_pending` made the metric read `ran`. A launch
//     failure now writes a classified, tenant-safe sentence to
//     `crawls.render_launch_error` (migration 0025) and the rows stay
//     `render_pending` for a later pass, which clears it on a successful
//     launch. A crawl re-judged at 0.19.0 can therefore CHANGE `ran` to
//     `failed` on a crawl whose last pass could not launch, and a pre-0025
//     crawl, or one whose pass launched, reads exactly as before. The metric
//     table gains a Render Launch Error column. No finding rule moves.
// 0.20.0: Phase 26a, rules over existing data (docs/superpowers/specs/2026-11-05-
// phase-26-checks-wave-1-design.md). ONE BUMP FOR THE PHASE; later tasks append
// here. The version moves for the new 26a rules, which read columns the crawl
// already stores; the rules are listed by family as the tasks that register them
// add them.
//
//  1. (T2) `resources.not-recorded` gains CHECK-85: mixed content reads
//     `page_resources`, so a crawl that recorded none is silent on it, and the
//     marker now says so. CHECK-84..86 are new checklist ids.
//  2. (T3) Security and served-type rules: `security.hsts-missing`,
//     `security.headers-missing`, the marker `security.headers-not-recorded`
//     (CHECK-84), `security.http-url` (CHECK-14), `security.mixed-content`
//     (CHECK-85) and `resources.bad-content-type` (CHECK-51). The header rules
//     read `pages.response_headers` and refuse a crawl any of whose pages
//     predates Phase 25, so a pre-25 crawl gets the marker, never a clean list.
//  3. (T4) Robots directives, page rules, all warning on CHECK-04:
//     `indexability.nofollow`, `directives.restrictive` and
//     `directives.unavailable-after`. They compare whole tokens
//     (`robotsTokens`), and judge a date against the page's own `fetched_at`.
//  4. (T5) Canonical rules: `canonical.relative` (info, CHECK-16) and
//     `canonical.fragment` (warning, CHECK-16) are page rules;
//     `canonical.chain` (warning, CHECK-17/19) and `canonical.unlinked` (info,
//     CHECK-17) are query rules over the resolved canonical pairs. The chain walk
//     stops at `CANONICAL_MAX_HOPS` and reports a revisit as `loop`; both
//     are filed on the page that declares the canonical.
//  5. (T6) Hreflang integrity, query rules on CHECK-24 over HTML declarations of
//     fetched, non-canonicalised pages: `hreflang.inconsistent-return-code`
//     (warning) and `hreflang.multiple-entries` (warning), `hreflang.self-only`
//     (info) and `hreflang.unlinked-target` (info). Codes compare as
//     `lower(btrim(code))` and targets on `URL_MATCH_KEY`; `x-default` is not
//     read as a language by the return-code rule.
//  6. (T7) Pagination, query rules: `pagination.non-indexable-target` (warning,
//     CHECK-22/23: a `rel=next` or `rel=prev` target the crawl fetched that is not
//     a 200 or says noindex), `pagination.loop` (warning, CHECK-22: a `rel=next`
//     cycle, reported once per member, found by a walk of at most
//     `PAGINATION_WALK_MAX` steps over the crawl's edges held in a temporary
//     table) and `pagination.sequence-error` (info, CHECK-22: the next page's
//     `rel=prev` is absent or names another page). The first two read targets
//     the earlier pagination rules already looked up; no column is new.
//  7. (T8) Link hygiene, query rules over the `links` table (no column is new):
//     `links.internal-nofollow` (warning, CHECK-33: an internal link with
//     `is_nofollow`), `links.only-from-non-indexable` (warning, CHECK-32: a
//     JUDGED page whose internal inlinks all come from pages that are
//     definitely not JUDGED), `links.localhost` (warning, CHECK-86: an EXTERNAL
//     link whose host `blockedHostReason` blocks, found through a SQL prefilter
//     built from `BLOCKED_HOSTS` and `BLOCKED_HOST_SUFFIXES`, which url-policy
//     now exports), `links.non-descriptive-anchor` (info, CHECK-86: an INTERNAL
//     link whose whole normalised anchor is on `NON_DESCRIPTIVE_ANCHORS`) and
//     `links.high-outlinks` (info, CHECK-33: distinct internal targets over
//     `HIGH_INTERNAL_OUTLINKS` or distinct external targets over
//     `HIGH_EXTERNAL_OUTLINKS`, calibrated against Screaming Frog in T13).
//  8. (T9) URL shape, seven page rules in `page/url-shape.ts`, all on the path of
//     the stored URL and gated by `isJudged` like `url.too-long`: `url.uppercase`
//     (info; the hex of a percent-escape is not a letter), `url.underscores`
//     (info), `url.non-ascii` (info), `url.spaces` (warning; `%20` or a
//     space), `url.multiple-slashes` (warning), `url.repetitive-path` (warning; a
//     run of segments immediately repeated) — all CHECK-30 — and
//     `url.internal-search` (warning, CHECK-67: a path segment `search`, or a
//     query key in `INTERNAL_SEARCH_PARAMS`, compared whole and case-sensitively).
//     `normalizeUrl` keeps case, underscores and `//` and percent-encodes a space
//     and non-ASCII, so every shape reaches the rules as stored. A URL that does
//     not parse throws.
//  9. (T10) Sitemap entries, four query rules in `query/sitemap-entries.ts`, SQL
//     over `sitemap_urls`: `sitemap.over-50k-urls` (warning, CHECK-08: a document
//     with more than `SITEMAP_URL_CAP` DEDUPLICATED entries, so the count is a
//     lower bound until 26c), `sitemap.url-too-long` (info, CHECK-07: a `<loc>`
//     over `SITEMAP_LOC_MAX` characters), `sitemap.cross-host-loc` (warning,
//     CHECK-07: scheme or host differs from the document's) and
//     `sitemap.lastmod-invalid` (info, CHECK-07: not `W3C_DATETIME`, or after
//     `crawls.finished_at`, which every sitemap read precedes; zone-less forms
//     are UTC at the period's start, so a date-only value on the crawl's own day
//     is not future). T14's re-judge moved the reference off `started_at`: a
//     sitemap stamped "now" when served read as future there.
// 10. (T12) Pixel width, four page rules in `page/pixel-width.ts`, gated by
//     `isJudged`, a present value and a measurable one: `title.pixel-too-long`
//     (warning, CHECK-35, wider than `TITLE_PX_MAX`), `title.pixel-too-short`
//     (info, CHECK-35, narrower than `TITLE_PX_MIN`),
//     `meta-description.pixel-too-long` (warning, CHECK-36, over `META_PX_MAX`)
//     and `meta-description.pixel-too-short` (info, CHECK-36, under
//     `META_PX_MIN`). Width is `serpWidth` (measured Chromium advances at
//     20px / 14px Arial); a value with a character outside the measured table
//     is NOT pixel-judged (the character-count rules still apply), and the
//     copy says so. T13's Screaming Frog 25.1 calibration CONFIRMED all four
//     bounds (561 / 200 / 985 / 400, strict) and moved one other threshold:
//     `HIGH_EXTERNAL_OUTLINKS` 100 -> 10 (SF flags 11 distinct external
//     targets and not 10); `HIGH_INTERNAL_OUTLINKS` 1000 was confirmed. See
//     docs/gates/phase-26a-calibration.md. This is the last rule task: 154 rules.
// 11. (T13 follow-up) `DEEP_DEPTH` stays 5. Screaming Frog, run with its
//     post-crawl analysis on, flags the click-depth ladder from depth 4 (its
//     depths equal ours); the owner kept 5 as a product choice (2026-11-06).
//     Same calibration doc, where the difference is recorded as owner-decided.
// 12. (PR #22 review) `security.http-url` reads `links`, not `pages`: an
//     `https:` crawl never fetches an `http:` URL, so the page-row rule could
//     not fire. It now files an HTTPS page fetched OK that links to an `http:`
//     URL on the site's own host (modulo `www.`; `is_internal` is false for
//     such a link and is not read), with `httpTargetCount` and a sorted
//     `sample` of `BROKEN_SAMPLE_RESOURCES`. `robotsTokens` splits on
//     whitespace as well as commas (closing up `name: value` first), so
//     `noindex nofollow` is two tokens for `indexability.nofollow` and
//     `directives.restrictive`, as it already was for `saysNoindex`.
//     `directives.unavailable-after` reads its date with `parseRobotsDate`
//     (ISO 8601, RFC 822 / 850 / 1123), not `Date.parse`: a zone-less form is
//     UTC with `assumedUtc: true`, and loose text is `dateParsed: false`.
//     The date ends at its longest prefix `parseRobotsDate` accepts, so a
//     directive after it with only a space between is still a token. The
//     parser also reads asctime (UTC, `assumedUtc`), full month and day names,
//     an ISO zone name or hours-only offset, and BST, CET, CEST, EET, EEST.
//     The pagination target lookup drops every `disallowed` row (url-policy
//     as well as robots.txt): never requested, so
//     `pagination.non-indexable-target` no longer reports a url-policy
//     refusal as a fetched non-200; `next-target-uncrawled` reports it.
//     `pagination.loop` gives the same findings for less work: series that
//     end are peeled off first, and each loop is walked once, from its
//     member with the smallest `md5(url)`, then fanned out to its members.
// 0.21.0: Phase 26b, one parser wave (extraction version 2). ONE BUMP FOR THE
// PHASE; later tasks append here. The version moves for the 26 new rules, which
// read page facts the crawler did not extract before.
//
//  1. (T1) Migration 0026 adds fifteen nullable `pages` columns, none with a
//     default (null means "not measured"): `html_lang`, `social`, `h2_text`,
//     `title_count`, `meta_description_count`, `robots_metas`, `meta_refresh`,
//     `anchor_counts`, `insecure_refs`, `images_empty_alt`,
//     `images_alt_too_long`, `images_missing_alt_sample`, `rel_next_count`,
//     `rel_prev_count` and `html_structure`, plus three duplicate-group indexes
//     (`pages_dupe_h2_text`, `pages_dupe_og_title`, `pages_dupe_og_description`).
//     `EXTRACTION_VERSION` moves 1 to 2 and the `refresh` response header joins
//     the allowlist. CHECK-87 (social sharing tags) and CHECK-88 (HTML document
//     structure) are new checklist ids; CHECK-85 widens to "Mixed content and
//     insecure forms". No rule is registered yet.
//  2. (T2) The analyzer fills `html_lang`, `social`, `h2_text`, `title_count`,
//     `meta_description_count`, `robots_metas` and `meta_refresh`. Two existing
//     behaviours move. `robots_meta` now holds EVERY `<meta name=robots>`
//     content joined with ", " (deviation 4), so `is_indexable` and every rule
//     reading the column see a `noindex` in a second robots meta.
//     `og:image` / `twitter:image` URLs become `resources` rows (kind `image`)
//     with no `page_resources` edge (deviation 3). Every resource rule and
//     marker that read `resources` without the edge table
//     (`resources.bad-content-type`, `images.oversized`,
//     `images.legacy-format`, `resources.uncached` and the four census markers)
//     now counts only rows a page loads; `resources.broken`, `page.weight` and
//     `security.mixed-content` already joined through `page_resources`.
//  3. (T3) The analyzer fills `anchor_counts`, `insecure_refs`,
//     `images_empty_alt`, `images_alt_too_long`, `images_missing_alt_sample`,
//     `rel_next_count` and `rel_prev_count`. `links.anchor` now includes the
//     trimmed alt of an image inside the link. Ruling R6: identical robots
//     contents collapse before the `robots_meta` join, and one meta naming a
//     twitter and an og tag counts as both. Migration 0027 (Ruling R7) widens
//     `title_count`, `meta_description_count`, `rel_next_count` and
//     `rel_prev_count` from smallint to integer, unclamped.
//  4. (T5) The v2 gate and its marker, `src/rules/query/page-facts.ts`:
//     `v2Gate` (a thin wrapper over `extractionCoverage(db, crawlId, 2)`) opens
//     every later query rule on a v2 fact, and `extraction.not-recorded` (info,
//     `marker`, category `crawl`) is the one NOT MEASURED marker for them all. It
//     fires once (`dedupeKey` "site") when any page is below version 2 and the
//     crawl has a FETCHED_OK page, and claims CHECK-04, 10, 18, 22, 24, 25, 34,
//     35, 36, 37, 49, 85, 86, 87 and 88. 155 rules.
//  5. (T6) The six social rules, all CHECK-87, category `on-page`, judged
//     pages only. Page rules (`src/rules/page/social.ts`, info):
//     `social.og-incomplete` and `social.x-incomplete` fire on a v2 row whose
//     `social` is null or incomplete (ruling R2); `social.og-multiple` and
//     `social.og-url-mismatch` need a non-null `social`. Query rules
//     (`src/rules/query/social.ts`): `social.og-duplicate` (info) groups
//     `og_title` then `og_description` through field-duplicates.ts'
//     `duplicateGroups` under one cap and one note, judging every crawl
//     (deviation 1); `social.image-broken` (warning) opens with `v2Gate` and
//     reports each og/X image that is relative, invalid, non-200, over
//     `SOCIAL_IMAGE_MAX_BYTES`, or `not-fetched` (no status recorded on a
//     crawl whose file check ran; ruling R13: when the check asked about
//     nothing, no image is listed for that and the marker speaks once).
//     `head.tags-outside-head` names `social` and claims CHECK-87;
//     `resources.not-recorded` and `resources.not-fetched` claim CHECK-87, and
//     `resources.not-fetched` also fires on a crawl whose only rows are
//     unasked share images and whose pages count no image (R13). 161 rules.
//  6. (T7) Heading and title rules, category `on-page`: `h2.missing`,
//     `h2.too-long`, `h2.duplicate`, `title.multiple`,
//     `meta-description.multiple` and `title.same-as-h1` (commit 06cf98e).
//     `title.same-as-h1`, `h2.missing` and `social.og-duplicate` judge every
//     crawl (deviation 1).
//  7. (T8) `directives.bot-conflict` (page, warning, CHECK-04: a bot-specific
//     robots meta whose noindex/nofollow state differs from the combined
//     `robots` meta; `none` counts as both), `redirect.meta-refresh` (page,
//     warning, CHECK-10: a meta refresh or `Refresh` header naming a URL, in
//     `src/rules/page/refresh.ts`) and `hreflang.html-lang-mismatch` (query,
//     info, CHECK-25: `v2Gate`, primary language subtag of `html_lang` against
//     the page's self hreflang codes). `parseRefresh` follows the HTML refresh
//     algorithm strictly (ruling R5). 170 rules.
//  8. (T9) Link rules. Page rules in `src/rules/page/anchors.ts` over
//     `pages.anchorCounts` (null on a v1 row, so silent): `links.uncrawlable`
//     (warning, CHECK-34: `<a>` with no href but onclick/role, a `javascript:`
//     href, or a `#` / `#!` href), `links.empty-href` and
//     `links.unsafe-target-blank` (info, CHECK-86). Query rule
//     `links.no-anchor-text` (info, CHECK-86) opens with `v2Gate` and counts
//     internal links whose stored anchor, image alt included, is empty. 174 rules.
//  9. (T10) Four page rules: `security.form-insecure` (warning, CHECK-85,
//     `isAuditable`: an `http:` page with a form, or an `https:` page with a form
//     whose action is `http:`), `images.empty-alt` and `images.alt-too-long`
//     (info, CHECK-49, `isJudged`; the 100-character limit is `IMAGE_ALT_MAX`,
//     applied at extraction) in `src/rules/page/technical.ts`, and
//     `pagination.multiple` (info, CHECK-22, `isAuditable`: more than one
//     rel=next or rel=prev) in the new `src/rules/page/pagination.ts`. Two
//     revisions: `security.mixed-content` also counts `http:` iframes and media
//     from `pages.insecure_refs` (one statement; a v1 page's finding is the
//     0.20.0 one, and a v2 page's gains the optional `byKind` evidence), and
//     `images.missing-alt` gains an optional `sample` of image addresses on a
//     v2 row. 178 rules.
// 10. (T11) Two page rules in the new `src/rules/page/html-structure.ts`, both
//     `isAuditable` and silent on a v1 row: `html.head-closed-early` (warning,
//     CHECK-18 / CHECK-04 / CHECK-24: the analyzer's `closedEarly`, which needs a
//     later head-only element or `</head>` as evidence the head was meant to
//     continue) and `html.structure-invalid` (info, CHECK-88: not exactly one
//     head or one body, or a head after the body). `head.directives-outside-head`
//     and `head.tags-outside-head` gain the optional `headClosedEarly` evidence
//     naming the closing element on a v2 row. 180 rules.
export const RULESET_VERSION = "0.21.0";

/**
 * The 47 crawl-derived checks (sf-audit checklist, Pre-Crawl + sections 1–11):
 * the universe a crawl can speak to. CI compares this against the registry's
 * claimed checks, so an unclaimed check is visible rather than silently absent.
 */
export const CRAWL_CHECK_IDS: readonly string[] = [
  "CHECK-01","CHECK-02","CHECK-03","CHECK-04","CHECK-05","CHECK-06","CHECK-07",
  "CHECK-08","CHECK-09","CHECK-10","CHECK-11","CHECK-12","CHECK-13","CHECK-14",
  "CHECK-15","CHECK-16","CHECK-17","CHECK-18","CHECK-19","CHECK-20","CHECK-21",
  "CHECK-22","CHECK-23","CHECK-24","CHECK-25","CHECK-26","CHECK-27","CHECK-28",
  "CHECK-29","CHECK-30","CHECK-31","CHECK-32","CHECK-33","CHECK-33b","CHECK-34",
  "CHECK-35","CHECK-36","CHECK-37","CHECK-38","CHECK-39","CHECK-40","CHECK-41",
  "CHECK-42","CHECK-43","CHECK-44","CHECK-45","CHECK-46",
];

/**
 * Judgement checks — never rules (build plan §6: no rule that always passes).
 *
 * THE ONLY ANNOTATION LEFT, and the only reason a crawl-derived check has no
 * finding rule behind it. Two others stood beside it and both are gone, each
 * deleted by the phase that discharged it: `METRIC_PENDING_CHECKS` (CHECK-08,
 * CHECK-29, CHECK-33, CHECK-33b — site-wide numbers rather than per-page faults)
 * left with Phase 4's metric rules, and `RENDER_CHECKS` (CHECK-01, CHECK-02,
 * CHECK-34 — questions about what a page shows AFTER its JavaScript has run)
 * with Phase 5's render diff rules, which are the pass that made those three
 * answerable at all. An annotation with nothing to annotate is a reason nobody
 * needs; a future check waiting on a future phase arrives with the rule that
 * claims it rather than with a list to join.
 *
 * The coverage pin is now empty in consequence: `unclaimedChecks(…)` returns
 * `[]`, which is what `test/rules/coverage.test.ts` asserts.
 */
export const AGENT_CHECKS: readonly string[] = ["CHECK-38", "CHECK-41", "CHECK-42"];

export function defineRule<T extends AnyRule>(rule: T): T {
  const fail = (msg: string): never => {
    throw new RuleDefinitionError(`rule '${rule.id ?? "<no id>"}': ${msg}`);
  };
  if (!rule.id || !RULE_ID.test(rule.id)) fail("id must be kebab/dot lowercase");
  if (!Array.isArray(rule.checkIds) || rule.checkIds.length === 0)
    fail("checkIds must claim at least one CHECK-NN");
  for (const c of rule.checkIds) if (!CHECK_ID.test(c)) fail(`bad checkId '${c}'`);
  if (!["critical", "warning", "info"].includes(rule.severity)) fail("bad severity");
  if (!(KINDS as readonly string[]).includes(rule.kind)) fail(`bad kind '${rule.kind}'`);
  for (const field of ["category", "title", "explanation", "howToFix", "rulesetVersion"] as const)
    if (!rule[field]) fail(`${field} is required (client-facing copy is not optional)`);
  if (typeof rule.run !== "function") fail("run must be a function");
  // A NOT MEASURED marker declares itself with the `marker` flag, whose value is
  // the reason it exists. The field is optional, but PRESENT-AND-EMPTY is a flag
  // with no reason — the exact drift the guard derives this set to prevent — so
  // it is refused here rather than reaching the registry as a silent marker.
  if (rule.marker !== undefined && (typeof rule.marker !== "string" || rule.marker.trim() === ""))
    fail("marker, when present, must be a non-empty reason string");
  validateColumns(rule, fail);
  validateTable(rule, fail);
  return rule;
}

/**
 * The keys a rule may NOT declare a column for, because the surface already
 * prints them.
 *
 * The first four are the STANDARD COLUMNS: they are derived from the `pages`
 * row a finding names (`indexabilityOf`, src/rules/helpers.ts) and prepended to
 * every rule's column list, so a rule declaring one of them would print two
 * columns under one heading, filled from two different sources. `pageUrl` is
 * the key `runRules` writes the finding's own URL under — `address` under
 * another name — and the harness already forbids a rule's evidence from
 * carrying it at all.
 */
const RESERVED_COLUMN_KEYS: ReadonlySet<string> = new Set([
  "address",
  "statusCode",
  "indexability",
  "indexabilityStatus",
  "pageUrl",
]);

/**
 * The HEADINGS the surface already prints, which is the same reservation read
 * from the other end.
 *
 * A rule cannot declare the standard KEYS, but nothing stopped it declaring a
 * different key under one of their LABELS — and a report with two columns
 * headed `Status Code`, one from the page row and one from the evidence, is a
 * table a reader cannot use. Labels are compared case-insensitively and
 * whitespace-trimmed because a header collision is what the EYE sees, not what
 * `===` sees.
 *
 * `Truncated` is here for the same reason and from the other surface: the
 * `issue_urls` CSV always ends with that column (`TRUNCATED_LABEL`,
 * src/api/csv.ts), so a rule heading a column of its own that way would put two
 * `Truncated` columns on one export.
 *
 * Spelled here rather than imported: `STANDARD_ISSUE_COLUMNS` lives in
 * src/api/service.ts and `TRUNCATED_LABEL` in src/api/csv.ts, both of which
 * depend on this registry and not the other way round. They are pinned to this
 * set by a test (test/rules/registry.test.ts, "the reserved headings are
 * exactly the ones the surface prints itself"), so the copy cannot drift in
 * silence.
 */
const RESERVED_COLUMN_LABELS: ReadonlySet<string> = new Set([
  "address",
  "status code",
  "indexability",
  "indexability status",
  "truncated",
]);

/** A label as a header collision sees it: trimmed, case-folded. */
const headingKey = (label: string): string => label.trim().toLowerCase();

/**
 * `RuleMeta.columns`, checked as far as a definition can be checked here.
 *
 * WHAT IS CHECKED IS THE DECLARATION, NOT THE EVIDENCE. Whether a declared key
 * is a key the rule actually writes is a question about a run, and the answer
 * lives in test/fixtures/harness.test.ts, over a real crawl of the fixture site
 * — both directions: a non-optional column that never appears, and an evidence
 * key no column names. `defineRule` sees a rule's metadata and not one finding,
 * so what it can hold is the shape: present on the kinds that find, absent on
 * the kind that measures, and every entry a usable heading.
 *
 * A HEADING IS AS UNIQUE AS A KEY. Two columns of one rule sharing a label, or
 * a rule borrowing a heading the surface prints itself, is a table whose reader
 * cannot tell which column is which — and unlike a duplicate key it is invisible
 * in the JSON, because only the printed report has headings.
 */
function validateColumns(rule: AnyRule, fail: (msg: string) => never): void {
  const columns = rule.columns;
  if (rule.kind === "metric") {
    if (columns !== undefined) {
      fail(
        "a metric rule declares no columns: it writes a table into `metrics` and " +
          "never an `issues` row, so there is no finding row for a column to describe",
      );
    }
    return;
  }
  if (!Array.isArray(columns)) {
    fail(
      "columns is required on a rule that finds (an EMPTY array is the answer for a " +
        "rule whose report is the four standard columns and nothing else)",
    );
  }
  const seen = new Set<string>();
  const seenLabels = new Set<string>();
  for (const column of columns) {
    if (column === null || typeof column !== "object" || Array.isArray(column))
      fail("every column must be an object {key, label}");
    const { key, label } = column as { key?: unknown; label?: unknown };
    if (typeof key !== "string" || key.trim() === "")
      fail("every column needs a non-empty key naming an evidence field");
    if (typeof label !== "string" || label.trim() === "")
      fail(`column '${key}' needs a non-empty label — the header a client prints`);
    if (RESERVED_COLUMN_KEYS.has(key))
      fail(`column '${key}' is a standard column the surface already prints`);
    if (seen.has(key)) fail(`column '${key}' is declared twice`);
    seen.add(key);
    const heading = headingKey(label);
    if (RESERVED_COLUMN_LABELS.has(heading))
      fail(
        `column '${key}' is headed '${label}', which the surface prints itself — ` +
          "two columns under one heading, filled from two sources",
      );
    if (seenLabels.has(heading))
      fail(`column '${key}' repeats the heading '${label}' of an earlier column`);
    seenLabels.add(heading);
    const optional = (column as { optional?: unknown }).optional;
    if (optional !== undefined && optional !== true)
      fail(`column '${key}': optional, when present, must be exactly true`);
  }
}

/**
 * `MetricRule.table`, checked as far as a definition can be checked here.
 *
 * The mirror of `validateColumns`, and the same split of responsibilities: this
 * function sees a DECLARATION and no stored row, so what it holds is the shape —
 * present on the kind that measures, absent on the kinds that find, and every
 * entry a usable heading. Whether a declared key names something the metric
 * actually writes is a question about a run, and test/fixtures/harness.test.ts
 * answers it over a real crawl, in both directions.
 *
 * A HEADING IS AS UNIQUE AS A KEY, and the uniqueness set here is WIDER than a
 * finding rule's: the summary labels are in it beside the column labels, because
 * the `metric_table` CSV writes the summary as leading columns repeated on every
 * row (src/api/csv.ts), so one header row carries both lists and a label in both
 * would be two columns a reader cannot tell apart.
 */
function validateTable(rule: AnyRule, fail: (msg: string) => never): void {
  const table = rule.table;
  if (rule.kind !== "metric") {
    if (table !== undefined) {
      fail(
        "only a metric rule declares a `table`: a rule that finds writes `issues` rows, " +
          "whose report is `columns`",
      );
    }
    return;
  }
  if (table === undefined) {
    fail(
      "a metric rule must declare its `table` — the shaper that turns its stored rows " +
        "into the rows a client reads, and the label over every column " +
        "(src/rules/registry/metric-table.ts)",
    );
  }
  if (typeof table !== "object" || Array.isArray(table)) fail("table must be a declaration object");

  // WHERE THE TABLE SITS IN THE SECTION, checked for the only property a
  // definition can carry: it is a position in a list, so a fraction, a negative
  // or a NaN is not one. Absent is allowed and means "after every table that
  // declares a position" (`METRIC_TABLE_ORDER_LAST`); what is refused is a value
  // that LOOKS declared and cannot be ordered.
  if (table.order !== undefined) {
    if (typeof table.order !== "number" || !Number.isInteger(table.order) || table.order < 0) {
      fail(
        "table.order, when present, is the metric's position in the metric section and must " +
          "be a non-negative integer — lower first, ties broken by rule id",
      );
    }
  }

  // The shaper's own arguments first, because a heading list built from a
  // malformed declaration would fail on the wrong thing.
  if (table.shape === "perScopeMeasure") {
    if (table.measures.length === 0)
      fail("perScopeMeasure needs at least one measure — it is a column of the table");
    const seen = new Set<string>();
    for (const measure of table.measures) {
      if (typeof measure.key !== "string" || measure.key.trim() === "")
        fail("every measure needs a non-empty key naming an object inside the metric's value");
      if (typeof measure.label !== "string" || measure.label.trim() === "")
        fail(`measure '${measure.key}' needs a non-empty label — the cell a client reads`);
      if (seen.has(headingKey(measure.label)))
        fail(`measure '${measure.key}' repeats the label '${measure.label}' of another measure`);
      seen.add(headingKey(measure.label));
    }
  }
  if (table.shape === "expandList") {
    if (table.lists.length === 0) fail("expandList needs at least one list to expand");
    const keys = new Set(table.columns.map((column) => column.key));
    for (const source of table.lists) {
      if (typeof source.field !== "string" || source.field.trim() === "")
        fail("every expanded list needs a non-empty field naming it on the site row");
      if (source.tag === undefined) {
        // One list needs no tag: every row came from it. Two do, or the rows of
        // the second are indistinguishable from the first's.
        if (table.lists.length > 1)
          fail(
            `list '${source.field}' is merged with another and carries no tag — nothing on ` +
              "its rows would say which list they came from",
          );
        continue;
      }
      if (!keys.has(source.tag.key))
        fail(
          `list '${source.field}' tags its rows under '${source.tag.key}', which is not one of ` +
            "this table's columns — the tag would be written into a cell nobody prints",
        );
      if (typeof source.tag.value !== "string" || source.tag.value.trim() === "")
        fail(`list '${source.field}' needs a non-empty tag value — a client reads it as a cell`);
    }
  }
  if (table.shape === "expandMap" && (typeof table.field !== "string" || table.field.trim() === ""))
    fail("expandMap needs a non-empty field naming the map on each stored row");

  // The reserved keys, checked against the DECLARED columns only: the scope and
  // measure columns are built from those same names by `metricTableColumns`, so
  // reading the whole list would refuse every table there is.
  const declared =
    table.shape === "expandMap"
      ? []
      : [...table.columns, ...(table.shape === "perScopeMeasure" ? table.scopeColumns : [])];
  for (const column of declared) {
    if (RESERVED_TABLE_KEYS.has(column.key))
      fail(
        `column '${column.key}' is a key this surface writes itself (the row's scope and its ` +
          "measure) — two columns under one key, filled from two sources",
      );
  }

  const columns = [...metricTableColumns(table), ...metricTableSummary(table)];
  const seen = new Set<string>();
  const seenLabels = new Set<string>();
  for (const column of columns) {
    if (column === null || typeof column !== "object" || Array.isArray(column))
      fail("every column must be an object {key, label}");
    const { key, label } = column as { key?: unknown; label?: unknown };
    if (typeof key !== "string" || key.trim() === "")
      fail("every column needs a non-empty key naming a path into the metric's value");
    if (typeof label !== "string" || label.trim() === "")
      fail(`column '${key}' needs a non-empty label — the header a client prints`);
    if (seen.has(key)) fail(`column '${key}' is declared twice`);
    seen.add(key);
    const heading = headingKey(label);
    if (seenLabels.has(heading))
      fail(
        `column '${key}' repeats the heading '${label}' — the scope column, the measure ` +
          "column, the value columns and the summary labels share one header row",
      );
    seenLabels.add(heading);
  }
}

export class Registry {
  private rules = new Map<string, AnyRule>();

  register(rule: AnyRule): void {
    defineRule(rule);
    if (this.rules.has(rule.id))
      throw new RuleDefinitionError(`duplicate rule id '${rule.id}'`);
    this.rules.set(rule.id, rule);
  }
  all(): AnyRule[] { return [...this.rules.values()]; }
  byKind<K extends AnyRule["kind"]>(kind: K): Extract<AnyRule, { kind: K }>[] {
    return this.all().filter((r): r is Extract<AnyRule, { kind: K }> => r.kind === kind);
  }
  claimedCheckIds(): Set<string> {
    return new Set(this.all().flatMap((r) => r.checkIds));
  }
  unclaimedChecks(allCheckIds: readonly string[], agentChecks: readonly string[]): string[] {
    const claimed = this.claimedCheckIds();
    const agent = new Set(agentChecks);
    return allCheckIds.filter((c) => !claimed.has(c) && !agent.has(c));
  }
}

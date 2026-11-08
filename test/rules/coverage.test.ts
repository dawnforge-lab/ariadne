/**
 * The coverage pin.
 *
 * Hard rule 10 says every rule traces to a checklist id, and the build plan
 * says coverage is a CI query rather than a claim in a document. This is that
 * query: it holds the exact set of crawl-derived checks NO rule claims yet, so
 * the number is visible in CI instead of being asserted in prose.
 *
 * The assertion is equality, not a ceiling, so it fails in both directions —
 * a check quietly dropped by a rule shows up as an addition, and a check newly
 * claimed shows up as a removal that must be deleted from the literal in the
 * same commit as the rule that claims it. Phase 3 took this list from 29 to
 * seven, Phase 4's link-graph metrics took it to five, and its URL and sitemap
 * metrics took it to three — the render three, CHECK-01, CHECK-02 and
 * CHECK-34, which no rule could answer until a browser had run the page's
 * JavaScript. **Phase 5's render diff rules claim all three, and the list is
 * now empty.** `RENDER_CHECKS` was the constant that annotated them and it is
 * deleted with them: 44 of the 47 crawl-derived checks have a rule, and the
 * other three are the agent's judgement.
 *
 * An empty pin is a stronger assertion than the lists that preceded it, not a
 * weaker one. It says every crawl-derived check either has a rule behind it or
 * is one of the three `AGENT_CHECKS`, and the moment a check is added to the
 * universe without a claimant this fails.
 *
 * Note the pin only ever *subtracts* from `CRAWL_CHECK_IDS`: rules claiming
 * checks outside those 47 (today CHECK-48, CHECK-49, CHECK-50, CHECK-51 and
 * CHECK-52, from checklist section 12) neither appear here nor shrink the list.
 * Phase 11 added two of those five — CHECK-48 through `page.weight`'s script
 * column and CHECK-51 through `resources.broken` — so the number of section-12
 * checks the engine speaks to grew while every number this file pins about the
 * 47 stayed exactly where it was. That is not an omission: the universe here is
 * the crawl-derived range the build plan drew, and section 12 has always been
 * outside it.
 */
import { describe, expect, it } from "vitest";

import { buildRegistry } from "../../src/rules/index.js";
import { AGENT_CHECKS, CRAWL_CHECK_IDS } from "../../src/rules/registry/registry.js";

/**
 * The metric rules allowed to carry an AGENT check's id, by check.
 *
 * A metric produces no findings and passes nothing, so it may supply EVIDENCE
 * for a judgement it does not make — but that exception is a door, and this
 * object is the list of who may walk through it. Every agent check appears
 * here, and the two that no rule may touch at all appear with an empty list:
 * without them, "metrics are exempt from the agent-check guard" would be a
 * blanket permission, and a metric that started claiming CHECK-41 or CHECK-42
 * would fail nothing.
 *
 * Adding an entry is a deliberate act with the same argument behind it that
 * CHECK-38 has: the rule must be a metric, and the check must be one whose
 * verdict the metric leaves to the agent.
 */
const AGENT_CHECK_EVIDENCE: Record<string, string[]> = {
  // Whether a page matches the intent it targets is judgement. These two
  // measure the text — a word-count distribution per template, and how alike a
  // template's pages are — and hand the numbers to the agent.
  "CHECK-38": ["content.metrics-by-type", "content.template-similarity"],
  // Content quality and E-E-A-T. Nothing a crawl stores is evidence a rule
  // could summarise without also implying the verdict, so no rule of any kind
  // claims either.
  "CHECK-41": [],
  "CHECK-42": [],
};

describe("checklist coverage", () => {
  it("pins the unclaimed set: nothing is left", () => {
    const unclaimed = buildRegistry().unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS]);
    // CHECK-33 and CHECK-33b left this list with the link-graph metrics, then
    // CHECK-08 (`sitemap.structure`) and CHECK-29 (`url.param-volumes`) with
    // the sitemap and URL metrics, and finally CHECK-01, CHECK-02 and CHECK-34
    // with the render diff rules. Empty, and asserted as a literal because
    // there is no annotation constant left to assert it against — that is the
    // point of the phase rather than an accident of it.
    expect(unclaimed).toEqual([]);
  });

  // The gate document's ruleset table states these four numbers — the Phase 5
  // gate doc, which is written at the end of the phase against what CI pins
  // here. Pinned so a rule added or dropped fails CI rather than quietly making
  // that table wrong. (Earlier gate docs' tables are records of what shipped
  // then; they are not updated, and these numbers have moved past them.)
  //
  // THE ARITHMETIC, verified against the registry rather than taken from the
  // plan (whose kind split was an authoring estimate). Phase 4 ended at 74 =
  // 26 page + 38 query + 10 metric. Phase 5 adds five rules, and the split
  // moved from the estimate because all four finding rules are query-kind: the
  // three diffs and the JS redirect all read stored columns through SQL rather
  // than being handed a `PageRecord`, and `filters.js-only` could not be a page
  // rule at all — its raw side is a question about the `links` table.
  //
  //   page    26 + 0 = 26
  //   query   38 + 4 = 42   (content.csr-dependent, nav.js-only,
  //                          filters.js-only, redirect.js)
  //   metric  10 + 1 = 11   (render.coverage)
  //   total   74 + 5 = 79
  //
  // Phase 7 Task 1 adds one page rule and no others: `content.thin-skipped`,
  // which reports the page `content.thin` could not judge because the crawl
  // that wrote it predates the column the floor now reads. It claims the same
  // two checks as the rule it stands in for, so the claimed-check arithmetic
  // below does not move.
  //
  //   page    26 + 1 = 27
  //   total   79 + 1 = 80
  //
  // Phase 7 Task 2 adds four QUERY rules — the three field-level duplicates and
  // the heading skip beside them. Query-kind because a duplicate is a fact about
  // two pages and a page rule is handed one; there is no page-rule spelling of
  // the question. The claimed-check arithmetic does not move here either, and
  // the reason is worth stating rather than looking like an oversight:
  // CHECK-35, CHECK-36 and CHECK-37 were ALREADY claimed, by `title.missing`,
  // `meta-description.missing` and `headings.h1-missing`. Claims are a set
  // union, so a check answered more completely does not appear as a new claim —
  // which is exactly how the duplicate gap survived to production with a
  // coverage pin that said nothing was unclaimed.
  //
  //   query   42 + 4 = 46   (title.duplicate, meta-description.duplicate,
  //                          h1.duplicate-text, h1.duplicate-skipped)
  //   total   80 + 4 = 84
  //
  // Phase 7 Task 4 adds one METRIC — `structure.click-depth-distribution`, the
  // shortest link path from the home page, computed by the `click_depth`
  // derivation — and MOVES a claim rather than making one:
  //
  //   metric  11 + 1 = 12
  //   total   84 + 1 = 85
  //
  // THE MOVED CLAIM, stated as set arithmetic because the pin below cannot show
  // it: CHECK-31 leaves `structure.depth-distribution` (which measures DISCOVERY
  // depth, where every sitemap entry is a starting point, and therefore cannot
  // answer "how many clicks from the home page") and is claimed by the new
  // metric instead. The claimed-check set does not move in either direction:
  // CHECK-31 keeps a claimant throughout (`structure.deep-page` claims it too,
  // and now the new metric), and the metric that gave it up takes CHECK-32,
  // which `links.orphan` already claims. Claims are a set union, so both edges
  // are invisible in the totals — which is exactly why they are written here.
  // Phase 9 Task 2 MOVES one rule between kinds and adds none.
  // `structure.deep-page` becomes a query rule, because the depth it reports is
  // `pages.click_depth` and a derivation writes that column AFTER the page
  // cursor has run — so as a page rule it read last run's value, or null, and
  // passed on every first judgement (hard rule 1).
  //
  //   page    27 - 1 = 26
  //   query   46 + 1 = 47
  //   total   85 + 0 = 85
  //
  // The claimed-check arithmetic below does not move, and that is the test of
  // whether this was a MOVE: same rule id, same CHECK-31, same severity, same
  // category. A coverage number that moved here would mean the rule was deleted
  // rather than relocated.
  // Phase 10 Task 2 adds one METRIC and no findings: `site.health`, the rollup
  // Talos draws its gauge from. It counts pages by the worst severity of the
  // findings the run just wrote, so it adds ROWS and changes no verdict — which
  // is why RULESET_VERSION stays at 0.7.0 (the Phase 8 T1 argument).
  //
  //   metric  12 + 1 = 13
  //   total   85 + 1 = 86
  //
  // THE CLAIMED-CHECK ARITHMETIC DID NOT MOVE, and here that was a disclosure
  // rather than a reassurance: `site.health` shipped carrying CHECK-32, which
  // THREE rules already claim — `links.orphan`, `links.orphan-skipped` and
  // `structure.depth-distribution` — because the checklist then had NO check for
  // a site-wide judgement rollup. The id was a FILING decision (a partition of
  // the page census, where the depth distribution lives) and the review ruled it
  // an EXPLICITLY TEMPORARY bridge, ledgered with a Phase 11 handoff.
  //
  // **P11-T4 discharged that ledger.** The checklist gained CHECK-83 "Engine
  // coverage and evidence completeness" — the check the audit answers first —
  // and `site.health` moved onto it. The arithmetic below still does not move,
  // for two independent reasons worth separating: CHECK-32 keeps all three of
  // its original claimants, so nothing was dropped from the claimed set; and
  // CHECK-83 is OUTSIDE `CRAWL_CHECK_IDS` — the build plan's 47 are the
  // crawl-derived range, and a check about the ENGINE's own coverage is not a
  // check about the site, exactly as checklist section 12 is not. So it adds
  // nothing to the pin either. Both directions are asserted below rather than
  // left to this paragraph.
  // Phase 11 Task 3 adds five QUERY rules and one METRIC, all reading the
  // `resources` and `page_resources` tables migration 0013 created:
  //
  //   query   47 + 5 = 52   (resources.broken, images.oversized,
  //                          images.legacy-format, resources.uncached,
  //                          resources.not-recorded)
  //   metric  13 + 1 = 14   (page.weight)
  //   total   86 + 6 = 92
  //
  // Query-kind, all five, for the reason the field duplicates are: each asks a
  // question about a TABLE — which files a page references, how heavy one file
  // is, how many pages carry it — and a page rule is handed one `pages` row and
  // nothing else. `resources.not-recorded` is the family's NOT MEASURED marker
  // (`content.thin-skipped`'s shape): a crawl written before migration 0013 has
  // no resource rows, every judging rule above is then silent, and a silence
  // whose reason is invisible is the always-passes defect one step later.
  //
  // THE CLAIMED-CHECK ARITHMETIC BELOW DOES NOT MOVE, and this time not one of
  // the new claims is even inside the universe: CHECK-48, CHECK-49, CHECK-50 and
  // CHECK-51 are all in checklist section 12, which the build plan's 47 have
  // never included. What DID change is the checklist itself, in the same commit
  // (hard rule 10): CHECK-49's "image WEIGHT and FORMAT are not measured",
  // CHECK-50's "caching headers … not stored" and CHECK-47's "nothing else about
  // performance" were made false by these rules and are gone, and CHECK-48 and
  // CHECK-51 gained Engine lines naming the halves the engine now answers.
  // Phase 12 Task 2 adds ONE query rule: `resources.not-fetched`, the sibling
  // marker the Phase 11 gate ledgered (§10.3). It reports the case
  // `resources.not-recorded` deliberately excludes — the rows exist and not one
  // of them was ever put to a server — and the two are mutually exclusive by
  // construction (`resourcesSeen == 0` against `resourcesSeen > 0`).
  //
  //   query   52 + 1 = 53
  //   total   92 + 1 = 93
  //
  // Query-kind for the family's reason: the question is about a TABLE. It is a
  // NEW verdict rather than a widened old one, which is what makes it additive
  // and what puts the ruleset bump (0.8.0 -> 0.9.0) in this task rather than
  // making it a change to a rule a stored finding already carries.
  //
  // THE CLAIMED-CHECK ARITHMETIC BELOW DOES NOT MOVE, for the reason P11-T3's
  // did not: CHECK-48, CHECK-49, CHECK-50 and CHECK-51 are section-12 checks,
  // outside the build plan's 47, and all four were already claimed by the rules
  // this marker stands in for. The claim is a set union — a check explained more
  // completely does not appear as a new claim — which is exactly why the pin
  // below asserts the marker's four ids directly.
  // Phase 13 Task 2 adds ONE query rule: `resources.all-unknown`, the third and
  // last resource marker (§10.1's owner-promotable pointer). It reports the case
  // BOTH existing markers exclude — every row decided into an unknown class, no
  // `ok` and no unasked-null — so it is mutually exclusive with `not-recorded`
  // (`seen == 0`) and `not-fetched` (`null == seen`) by construction, and a NEW
  // verdict rather than a widened old one, which puts the ruleset bump
  // (0.9.0 -> 0.10.0) in this task.
  //
  //   query   53 + 1 = 54
  //   total   93 + 1 = 94
  //
  // THE CLAIMED-CHECK ARITHMETIC BELOW STILL DOES NOT MOVE, for the reason it
  // did not for the two markers before it: CHECK-48/49/50/51 are section-12
  // checks outside the build plan's 47, and all four were already claimed by the
  // rules this marker stands in for. A check explained more completely is not a
  // new claim.
  // Phase 14 Task 1 adds ONE query rule: `resources.partial-unknown`, the fourth
  // and last resource marker (phase-13.md §8 pointer 1). It reports the MIX the
  // other three each exclude — some rows null, the rest a decided unknown class,
  // no `ok` and no broken row — so it is mutually exclusive with `not-recorded`
  // (`seen == 0`), `not-fetched` (`null == seen`) and `all-unknown`
  // (`decidedUnknown == seen`) by construction, and a NEW verdict rather than a
  // widened old one, which puts the ruleset bump (0.10.0 -> 0.11.0) in this task.
  //
  //   query   54 + 1 = 55
  //   total   94 + 1 = 95
  //
  // THE CLAIMED-CHECK ARITHMETIC STILL DOES NOT MOVE: CHECK-48/49/50/51 are
  // section-12 checks outside the build plan's 47, and all four were already
  // claimed by the rules this marker stands in for.
  // Phase 17 Task 3 adds ONE page rule: `http.server-error-transient`, the 5xx a
  // second observation cleared. It is the other half of a SPLIT rather than a
  // marker's arrival — `http.server-error` stops firing on exactly the rows this
  // one claims, so the two partition `fetch_class = 'server_error'` and the
  // ruleset bump (0.12.0 -> 0.13.0) carries a verdict move as well as an
  // addition.
  //
  //   page    26 + 1 = 27
  //   total   95 + 1 = 96
  //
  // Phase 19 adds FOUR query rules and no page rule: `links.to-server-error`
  // (the 5xx half of the broken-link question), `hreflang.missing-self-
  // reference`, and the two NOT MEASURED markers `hreflang.alternates-not-
  // crawled` and `content.near-duplicate-skipped`. No new check is claimed:
  // each lands on a check its sibling already claimed (CHECK-11, CHECK-24/26,
  // CHECK-39).
  //
  //   query   55 + 4 = 59
  //   total   96 + 4 = 100
  //
  // THE CLAIMED-CHECK ARITHMETIC DOES NOT MOVE: both rules claim CHECK-12, which
  // `http.server-error` already claimed. A check answered in two bands is not a
  // new claim.
  //
  // Phase 19 §11 MOVES TWO RULES BETWEEN KINDS and adds none. `content.thin`
  // and `content.thin-skipped` become query rules: the thin-content floor now
  // reads `main_word_count`, whose null means "this page has no content of its
  // own" on a 0018 crawl and "nothing here was ever measured" on an older one,
  // and only a census of the CRAWL tells those apart — which a page rule,
  // handed one row, cannot ask (`structure.deep-page`'s move in Phase 9 Task 2
  // is the precedent: same rule, same check, honest kind).
  //
  //   page    27 - 2 = 25
  //   query   59 + 2 = 61
  //   total   100 + 0 = 100
  //
  // The claimed-check arithmetic does not move, and that is the test of whether
  // this was a MOVE: same ids, same CHECK-40 + CHECK-13, same severities, same
  // category.
  //
  // Phase 23 Task 2 adds FOUR page rules over fetch outcomes no rule judged
  // before: `http.no-response` and `http.no-response-transient` (the
  // timeout/network-error pair, split on the recheck as the 5xx pair is),
  // `page.html-too-large` and the `crawl.unreadable-encoding` marker.
  //
  //   page    25 + 4 = 29
  //   total   100 + 4 = 104
  //
  // THE CLAIMED-CHECK ARITHMETIC DOES NOT MOVE: three claim CHECK-12 (already
  // claimed by `http.server-error`) and the marker claims CHECK-05 (already
  // claimed by `crawl.blocked`).
  //
  // Phase 23 Task 3 adds ONE query rule, `robots.blocks-internal-urls`: the
  // internal URLs robots.txt disallows, recorded by the crawl instead of
  // dropped, each with its inlinks.
  //
  //   query   61 + 1 = 62
  //   total   104 + 1 = 105
  //
  // The claimed-check arithmetic does not move: it claims CHECK-03, already
  // claimed by the three robots rules beside it.
  //
  // Phase 23 Task 4 adds TWO page rules, `headings.h1-too-long` (CHECK-37) and
  // `url.too-long` (CHECK-28), both info and both claiming checks their
  // neighbours already claim.
  //
  //   page    29 + 2 = 31
  //   total   105 + 2 = 107
  //
  // Phase 23 Task 5 adds TWO page rules over where the head ended:
  // `head.directives-outside-head` (CHECK-18, CHECK-04, CHECK-24) and
  // `head.tags-outside-head` (CHECK-35, CHECK-36), every one of those checks
  // already claimed by the canonical, indexability, hreflang, title and
  // description rules, so the claimed-check arithmetic does not move.
  //
  //   page    31 + 2 = 33
  //   total   107 + 2 = 109
  //
  // Phase 23 Task 6 adds FIVE query rules, raw versus rendered divergence:
  // `render.noindex-changed`, `render.canonical-changed`,
  // `render.title-changed`, `render.meta-description-changed` and
  // `render.h1-changed`. Each claims CHECK-01 (the render check) and its
  // element's own check (CHECK-04, -18, -35, -36, -37), every one of them
  // already claimed, so the claimed-check arithmetic does not move.
  //
  //   query   62 + 5 = 67
  //   total   109 + 5 = 114
  //
  // Phase 26a Task 3 adds SIX query rules: `security.hsts-missing`,
  // `security.headers-missing`, the marker `security.headers-not-recorded`
  // (CHECK-84), `security.http-url` (CHECK-14), `security.mixed-content`
  // (CHECK-85) and `resources.bad-content-type` (CHECK-51). CHECK-14 and
  // CHECK-51 were claimed already, CHECK-84 and CHECK-85 are new checklist ids
  // outside the build plan's 47, so the claimed-check arithmetic does not move.
  //
  //   query   67 + 6 = 73
  //   total   114 + 6 = 120
  //
  // Phase 26a Task 4 adds THREE page rules over robots directives:
  // `indexability.nofollow`, `directives.restrictive` and
  // `directives.unavailable-after`, all warning and all CHECK-04, which the
  // noindex rules claim already, so the claimed-check arithmetic does not move.
  //
  //   page    33 + 3 = 36
  //   total   120 + 3 = 123
  //
  // Phase 26a Task 5 adds FOUR canonical rules: the page rules
  // `canonical.relative` and `canonical.fragment` (CHECK-16) and the query rules
  // `canonical.chain` (CHECK-17, CHECK-19) and `canonical.unlinked` (CHECK-17).
  // All three checks are claimed already, so the claimed-check arithmetic does
  // not move.
  //
  //   page    36 + 2 = 38
  //   query   73 + 2 = 75
  //   total   123 + 4 = 127
  //
  // Phase 26a Task 6 adds FOUR hreflang query rules, all on CHECK-24, which is
  // claimed already: `hreflang.inconsistent-return-code`, `hreflang.multiple-
  // entries`, `hreflang.self-only` and `hreflang.unlinked-target`.
  //
  //   query   75 + 4 = 79
  //   total   127 + 4 = 131
  //
  // Phase 26a Task 7 adds THREE pagination query rules on CHECK-22 and CHECK-23,
  // both claimed already: `pagination.non-indexable-target`, `pagination.loop`
  // and `pagination.sequence-error`.
  //
  //   query   79 + 3 = 82
  //   total   131 + 3 = 134
  //
  // Phase 26a Task 8 adds FIVE link-hygiene query rules: `links.internal-
  // nofollow` and `links.high-outlinks` (CHECK-33), `links.only-from-non-
  // indexable` (CHECK-32) and `links.localhost` and `links.non-descriptive-
  // anchor` (CHECK-86, which Task 2 added). Both older checks are claimed
  // already, so the claimed-check arithmetic does not move.
  //
  //   query   82 + 5 = 87
  //   total   134 + 5 = 139
  //
  // Phase 26a Task 9 adds SEVEN URL-shape PAGE rules in `src/rules/page/url-shape.ts`:
  // six on CHECK-30 (`url.uppercase`, `url.underscores`, `url.non-ascii`,
  // `url.spaces`, `url.multiple-slashes`, `url.repetitive-path`) and
  // `url.internal-search` on CHECK-67.
  //
  //   page    38 + 7 = 45
  //   total   139 + 7 = 146
  //
  // Phase 26a Task 10 adds FOUR sitemap-entry QUERY rules in
  // `src/rules/query/sitemap-entries.ts`: `sitemap.over-50k-urls` on CHECK-08 and
  // `sitemap.url-too-long`, `sitemap.cross-host-loc` and `sitemap.lastmod-invalid`
  // on CHECK-07.
  //
  //   query   87 + 4 = 91
  //   total   146 + 4 = 150
  //
  // Phase 26a Task 12 adds FOUR pixel-width PAGE rules in
  // `src/rules/page/pixel-width.ts`: `title.pixel-too-long` and
  // `title.pixel-too-short` on CHECK-35, `meta-description.pixel-too-long` and
  // `meta-description.pixel-too-short` on CHECK-36. The last rule task.
  //
  //   page    45 + 4 = 49
  //   total   150 + 4 = 154
  //
  // Phase 26b Task 5 adds ONE query rule, the `extraction.not-recorded` marker in
  // `src/rules/query/page-facts.ts`, claiming the fifteen checks a v2-gated rule
  // reads.
  //
  //   query   91 + 1 = 92
  //   total   154 + 1 = 155
  //
  // Phase 26b Task 6 adds the six social rules on CHECK-87: FOUR page rules in
  // `src/rules/page/social.ts` (`social.og-incomplete`, `social.og-multiple`,
  // `social.og-url-mismatch`, `social.x-incomplete`) and TWO query rules in
  // `src/rules/query/social.ts` (`social.og-duplicate`, `social.image-broken`).
  //
  //   page    49 + 4 = 53
  //   query   92 + 2 = 94
  //   total   155 + 6 = 161
  //
  // Phase 26b Task 7 adds six more: FIVE page rules in
  // `src/rules/page/on-page.ts` (`h2.missing`, `h2.too-long`, `title.multiple`,
  // `meta-description.multiple`, `title.same-as-h1`) and ONE query rule,
  // `h2.duplicate`, in `src/rules/query/field-duplicates.ts`.
  //
  //   page    53 + 5 = 58
  //   query   94 + 1 = 95
  //   total   161 + 6 = 167
  //
  // Phase 26b Task 8 adds TWO page rules, `directives.bot-conflict` (CHECK-04)
  // and `redirect.meta-refresh` (CHECK-10), and ONE query rule,
  // `hreflang.html-lang-mismatch` (CHECK-25); all three claim checks already
  // claimed.
  //
  //   page    58 + 2 = 60
  //   query   95 + 1 = 96
  //   total   167 + 3 = 170
  //
  // Phase 26b Task 9 adds THREE page rules, `links.uncrawlable` (CHECK-34),
  // `links.empty-href` and `links.unsafe-target-blank` (CHECK-86), and ONE query
  // rule, `links.no-anchor-text` (CHECK-86); all four claim checks already claimed.
  //
  //   page    60 + 3 = 63
  //   query   96 + 1 = 97
  //   total   170 + 4 = 174
  //
  // Phase 26b Task 10 adds FOUR page rules: `security.form-insecure` (CHECK-85,
  // in `src/rules/page/technical.ts`), `images.empty-alt` and
  // `images.alt-too-long` (CHECK-49, same file) and `pagination.multiple`
  // (CHECK-22, `src/rules/page/pagination.ts`). `security.mixed-content`
  // widens, and is not a new rule.
  //
  //   page    63 + 4 = 67
  //   query   97
  //   total   174 + 4 = 178
  //
  // Phase 26b Task 11 adds TWO page rules in `src/rules/page/html-structure.ts`:
  // `html.head-closed-early` (CHECK-18 / CHECK-04 / CHECK-24) and
  // `html.structure-invalid` (CHECK-88). Both claim checks already claimed.
  //
  //   page    67 + 2 = 69
  //   query   97
  //   total   178 + 2 = 180
  //
  // Owner call O1 (2026-11-07) adds ONE query rule, `links.aria-label-only`
  // (CHECK-86, already claimed), in `src/rules/query/link-hygiene.ts`.
  //
  //   page    69
  //   query   97 + 1 = 98
  //   total   180 + 1 = 181
  //
  // Owner call O3 (2026-11-07) adds ONE page rule,
  // `html.head-closed-early-harmless` (CHECK-18 / CHECK-04 / CHECK-24, already
  // claimed), in `src/rules/page/html-structure.ts`.
  //
  //   page    69 + 1 = 70
  //   query   98
  //   total   181 + 1 = 182
  //
  // Phase 26c Task 2 adds ONE page rule, `url.reference-too-long` (CHECK-28,
  // already claimed), in `src/rules/page/on-page.ts`.
  //
  //   page    70 + 1 = 71
  //   query   98
  //   total   182 + 1 = 183
  //
  // Phase 26c Task 4 adds ONE page rule, `social.image-insecure` (CHECK-87,
  // already claimed), in `src/rules/page/social.ts`.
  //
  //   page    71 + 1 = 72
  //   query   98
  //   total   183 + 1 = 184
  //
  // Phase 26c Task 9 adds TWO query rules in `src/rules/query/sitemap-entries.ts`,
  // `sitemap.oversized` and `sitemap.url-in-multiple` (both CHECK-08, already
  // claimed).
  //
  //   page    72
  //   query   98 + 2 = 100
  //   total   184 + 2 = 186
  //
  // Phase 26c Task 10 adds ONE query rule, `hreflang.source-conflict`
  // (CHECK-24, already claimed), in `src/rules/query/hreflang-integrity.ts`.
  //
  //   page    72
  //   query   100 + 1 = 101
  //   total   186 + 1 = 187
  //
  // The PR #24 review adds ONE query rule, the marker
  // `hreflang.declarations-incomplete` (CHECK-24, already claimed), in
  // `src/rules/query/hreflang.ts`.
  //
  //   page    72
  //   query   101 + 1 = 102
  //   total   187 + 1 = 188
  it("pins the ruleset split: 188 rules = 72 page + 102 query + 14 metric", () => {
    const registry = buildRegistry();
    expect(registry.all()).toHaveLength(188);
    expect(registry.byKind("page")).toHaveLength(72);
    expect(registry.byKind("query")).toHaveLength(102);
    // The link-graph five, the two content metrics and hreflang coverage, plus
    // the URL-parameter, redirect-volume and sitemap-structure metrics, plus
    // the render pass's coverage, the health rollup, and the page-weight table.
    expect(registry.byKind("metric")).toHaveLength(14);
  });

  // The section-12 claims, pinned in both directions the way CHECK-31's move is:
  // a rule that quietly dropped one of these checks, or a new rule that claimed
  // one without an argument, fails here rather than in an audit six weeks later.
  it("the resource rules claim the section-12 checks their evidence actually answers", () => {
    const byId = new Map(buildRegistry().all().map((r) => [r.id, r.checkIds]));
    // A file that answered 4xx or 5xx is a failed network request — CHECK-51's
    // own DevTools recipe is `list_network_requests — filter 4xx/5xx`. It is
    // NOT an optimisation question (CHECK-49) and not a render-blocking or
    // bundle-size one (CHECK-48), which is the split the plan proposed and the
    // checklist's text does not support.
    expect(byId.get("resources.broken")).toEqual(["CHECK-51"]);
    // A file served under the wrong type is the same check: broken and
    // wrong-typed resources are one network-request question (26a).
    expect(byId.get("resources.bad-content-type")).toEqual(["CHECK-51"]);
    expect(byId.get("images.oversized")).toEqual(["CHECK-49"]);
    expect(byId.get("images.legacy-format")).toEqual(["CHECK-49"]);
    expect(byId.get("resources.uncached")).toEqual(["CHECK-50"]);
    // Bundle SIZE is CHECK-48's second half and image weight per template is
    // CHECK-49's; a metric evidences both and judges neither.
    expect(byId.get("page.weight")).toEqual(["CHECK-48", "CHECK-49"]);
    // The marker claims every check whose silence it explains, `page.weight`'s
    // included — the `content.thin-skipped` contract. CHECK-87 (26b): a share
    // image's status and size come from the same file check.
    expect(byId.get("resources.not-recorded")).toEqual([
      "CHECK-48",
      "CHECK-49",
      "CHECK-50",
      "CHECK-51",
      "CHECK-85",
      "CHECK-87",
    ]);
    // And its sibling claims the same four (P12-T2): the silence it explains is
    // the same silence, so a marker claiming fewer would leave a check whose
    // reader never meets it. CHECK-87 too, for the share image (26b).
    expect(byId.get("resources.not-fetched")).toEqual([
      "CHECK-48",
      "CHECK-49",
      "CHECK-50",
      "CHECK-51",
      "CHECK-87",
    ]);
    // The third marker (P13-T2) claims the same four again, for the same reason:
    // on a crawl whose every row is a decided unknown class the same four
    // judging rules go quiet, so the marker that explains their silence must be
    // named in each of their entries.
    expect(byId.get("resources.all-unknown")).toEqual([
      "CHECK-48",
      "CHECK-49",
      "CHECK-50",
      "CHECK-51",
    ]);
    // The fourth marker (P14-T1) claims the same four again, for the same reason:
    // on a partial pass whose decided rows are all unknown and the rest unasked
    // the same four judging rules go quiet, so the marker that explains their
    // silence must be named in each of their entries.
    expect(byId.get("resources.partial-unknown")).toEqual([
      "CHECK-48",
      "CHECK-49",
      "CHECK-50",
      "CHECK-51",
    ]);
  });

  // THE OTHER MOVED CLAIM (P11-T4), asserted in every direction the paragraph
  // above argues it in. A re-file that only changed the id would leave CHECK-32
  // one claimant short, or leave the coverage check inside a universe it does not
  // belong to, and neither is visible in any count.
  it("site.health is filed under the engine-coverage check, and CHECK-32 lost no claimant", () => {
    const registry = buildRegistry();
    const byId = new Map(registry.all().map((r) => [r.id, r.checkIds]));
    expect(byId.get("site.health")).toEqual(["CHECK-83"]);

    // The bridge is gone: no rule of any kind files a crawl summary under the
    // orphan check any more.
    const orphanClaimants = registry
      .all()
      .filter((r) => r.checkIds.includes("CHECK-32"))
      .map((r) => r.id)
      .sort();
    expect(orphanClaimants).toEqual([
      "links.only-from-non-indexable",
      "links.orphan",
      "links.orphan-skipped",
      "structure.depth-distribution",
    ]);

    // And CHECK-83 is outside the crawl-derived universe, so nothing about the
    // 47 moved when it arrived — the section-12 precedent, asserted rather than
    // assumed.
    expect(CRAWL_CHECK_IDS).not.toContain("CHECK-83");
    expect(AGENT_CHECKS).not.toContain("CHECK-83");
  });

  // The moved claim, asserted rather than only argued. Both directions: the
  // discovery-depth metric must NOT claim CHECK-31 (a metric measuring the crawl
  // under the checklist id for the site's structure is the defect this task
  // removed), and the click-depth metric must.
  it("CHECK-31 is claimed by the metric that measures click depth, not by the crawl's own depth", () => {
    const byId = new Map(buildRegistry().all().map((r) => [r.id, r.checkIds]));
    expect(byId.get("structure.click-depth-distribution")).toEqual(["CHECK-31"]);
    expect(byId.get("structure.depth-distribution")).not.toContain("CHECK-31");
    // And CHECK-31 never went unclaimed on the way: the rule that names
    // individual deep pages has claimed it since Phase 3 — as a page rule then,
    // as a query rule over `click_depth` since Phase 9, with the claim carried
    // across the move.
    expect(byId.get("structure.deep-page")).toContain("CHECK-31");
  });

  it("accounts for all 47 crawl-derived checks: 44 claimed, 3 agent, 0 unclaimed", () => {
    // The arithmetic behind the pin above, stated so a drift in the universe
    // itself (an id added to or removed from `CRAWL_CHECK_IDS`) fails here
    // rather than silently changing what "unclaimed" means.
    const registry = buildRegistry();
    const claimed = registry.claimedCheckIds();
    const agent = new Set(AGENT_CHECKS);
    // Agent checks are excluded from the claimed bucket rather than assumed
    // absent from it: a METRIC may carry an agent check's id (see the test
    // below), and counting it in both buckets would make the arithmetic sum to
    // 48 while every individual number stayed right.
    const claimedInUniverse = CRAWL_CHECK_IDS.filter((c) => claimed.has(c) && !agent.has(c));
    const unclaimed = registry.unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS]);

    expect(CRAWL_CHECK_IDS).toHaveLength(47);
    expect(AGENT_CHECKS).toHaveLength(3);
    expect(claimedInUniverse.sort()).toEqual([
      // The render three, claimed in Phase 5: CHECK-01 by
      // `content.csr-dependent` (and evidenced by `render.coverage`), CHECK-02
      // by `filters.js-only`, CHECK-34 by `nav.js-only`.
      "CHECK-01","CHECK-02",
      "CHECK-03","CHECK-04","CHECK-05","CHECK-06","CHECK-07","CHECK-08","CHECK-09",
      "CHECK-10","CHECK-11","CHECK-12","CHECK-13","CHECK-14","CHECK-15","CHECK-16",
      "CHECK-17","CHECK-18","CHECK-19","CHECK-20","CHECK-21","CHECK-22","CHECK-23",
      "CHECK-24","CHECK-25","CHECK-26","CHECK-27","CHECK-28","CHECK-29",
      "CHECK-30","CHECK-31","CHECK-32",
      "CHECK-33","CHECK-33b","CHECK-34",
      "CHECK-35","CHECK-36","CHECK-37","CHECK-39","CHECK-40",
      "CHECK-43","CHECK-44","CHECK-45","CHECK-46",
    ]);
    expect(claimedInUniverse.length + AGENT_CHECKS.length + unclaimed.length).toBe(
      CRAWL_CHECK_IDS.length,
    );

    // No FINDING-producing rule claims a check the agent owns: an AGENT check
    // with a page or query rule behind it is a rule that always passes (build
    // plan §6), because the thing being checked is a judgement no amount of
    // crawl data settles.
    //
    // A METRIC is the exception, and it is a principled one rather than a hole:
    // a metric produces no findings and passes nothing. It states what was
    // counted and leaves the verdict to the agent, which is precisely the
    // division AGENT_CHECKS exists to protect. `content.metrics-by-type` and
    // `content.template-similarity` therefore carry CHECK-38 as EVIDENCE for a
    // judgement they do not make.
    const judging = new Set(
      registry
        .all()
        .filter((r) => r.kind !== "metric")
        .flatMap((r) => r.checkIds),
    );
    for (const agentCheck of AGENT_CHECKS) {
      expect(judging.has(agentCheck), `${agentCheck} is an AGENT check, not a rule's`).toBe(false);
    }
  });

  // The other direction of the same ruling, for EVERY agent check rather than
  // for the one that has a claimant: an agent check's evidence is an explicit
  // allowlist, and every claimant on it must be a metric.
  //
  // The guard above exempts metrics from the agent-check prohibition BY KIND,
  // which on its own is a blanket permission — a metric that started claiming
  // CHECK-41 would pass it silently. This is what closes that: the claimant set
  // of each agent check is pinned exactly, so a new claim fails CI until
  // someone adds it to `AGENT_CHECK_EVIDENCE` on purpose, and a metric that
  // dropped CHECK-38 fails it just as loudly.
  it("each agent check's evidence is exactly its allowlist, and every claimant is a metric", () => {
    const registry = buildRegistry();

    // Every agent check is answered by the allowlist — a fourth id added to
    // AGENT_CHECKS with no entry here would otherwise be exempt by omission,
    // which is the hole this test exists to close.
    expect([...AGENT_CHECKS].sort(), "every AGENT check needs an evidence entry").toEqual(
      Object.keys(AGENT_CHECK_EVIDENCE).sort(),
    );

    for (const [agentCheck, allowed] of Object.entries(AGENT_CHECK_EVIDENCE)) {
      const claimants = registry.all().filter((r) => r.checkIds.includes(agentCheck));
      expect(claimants.map((r) => r.id).sort(), `${agentCheck} claimants`).toEqual(
        [...allowed].sort(),
      );
      for (const r of claimants) expect(r.kind, `${r.id} claims ${agentCheck}`).toBe("metric");
      // And an agent check stays out of the unclaimed pin whether or not a
      // metric evidences it: the agent owns the verdict either way.
      expect(registry.unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS])).not.toContain(
        agentCheck,
      );
    }
  });

  // The annotation contract, after the last annotation was discharged.
  //
  // The rule it enforced — every unclaimed check carries a written reason, and
  // every written reason names a still-unclaimed check — used to be an equality
  // between the pin and a constant. With `RENDER_CHECKS` deleted there is no
  // constant left, and the same contract collapses into a single statement:
  // NOTHING is unclaimed without a reason because nothing is unclaimed. This is
  // therefore the assertion that has to fail first if a future phase adds a
  // check to the universe with no rule and no annotation to explain it — the
  // reason it is kept as its own test rather than folded into the pin above.
  it("no crawl-derived check is unclaimed and unexplained", () => {
    const unclaimed = buildRegistry().unclaimedChecks(CRAWL_CHECK_IDS, AGENT_CHECKS);
    expect(
      unclaimed,
      "a check with no rule behind it needs an annotation constant saying which " +
        "phase can answer it, and a test pinning the pin against that constant — " +
        "the shape `RENDER_CHECKS` and `METRIC_PENDING_CHECKS` had before their " +
        "rules landed",
    ).toEqual([]);
  });
});

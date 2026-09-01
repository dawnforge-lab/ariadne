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
 * checks outside those 47 (today CHECK-49, CHECK-50 and CHECK-52, from
 * checklist section 12) neither appear here nor shrink the list.
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
  // THE CLAIMED-CHECK ARITHMETIC DOES NOT MOVE, and here that is a disclosure
  // rather than a reassurance: `site.health` carries CHECK-32, which
  // `links.orphan` and `structure.depth-distribution` already claim, because the
  // checklist has NO check for a site-wide judgement rollup — its Evaluation
  // Principle 2 says a crawl summary answers no check at all. The id is a filing
  // decision (a partition of the page census, where the depth distribution
  // lives), stated as one in the rule's module header, and not a claim that this
  // metric answers the orphan check.
  it("pins the ruleset split the gate doc reports: 86 rules = 26 page + 47 query + 13 metric", () => {
    const registry = buildRegistry();
    expect(registry.all()).toHaveLength(86);
    expect(registry.byKind("page")).toHaveLength(26);
    expect(registry.byKind("query")).toHaveLength(47);
    // The link-graph five, the two content metrics and hreflang coverage, plus
    // the URL-parameter, redirect-volume and sitemap-structure metrics, plus
    // the render pass's coverage, plus the health rollup.
    expect(registry.byKind("metric")).toHaveLength(13);
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

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
 * metrics took it to three — which are now exactly `RENDER_CHECKS`, the one
 * annotation left, naming the one phase that can answer them: the render pass
 * (Phase 5). The pin is asserted against that constant rather than against a
 * re-typed literal, so there is one list rather than two that agree today.
 *
 * Note the pin only ever *subtracts* from `CRAWL_CHECK_IDS`: rules claiming
 * checks outside those 47 (today CHECK-49, CHECK-50 and CHECK-52, from
 * checklist section 12) neither appear here nor shrink the list.
 */
import { describe, expect, it } from "vitest";

import { buildRegistry } from "../../src/rules/index.js";
import {
  AGENT_CHECKS,
  CRAWL_CHECK_IDS,
  RENDER_CHECKS,
} from "../../src/rules/registry/registry.js";

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
  it("pins exactly which crawl-derived checks remain unclaimed (the render three)", () => {
    const unclaimed = buildRegistry().unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS]);
    // CHECK-33 and CHECK-33b left this list with the link-graph metrics, then
    // CHECK-08 (`sitemap.structure`) and CHECK-29 (`url.param-volumes`) with
    // the sitemap and URL metrics. What remains is the render pass alone —
    // pinned against the CONSTANT rather than against a re-typed literal, so
    // the pin and the annotation are one fact and cannot drift apart.
    expect(unclaimed.sort()).toEqual([...RENDER_CHECKS].sort());
  });

  // The gate document's ruleset table states these three numbers — the Phase 4
  // gate doc, which is written at the end of the phase against what CI pins
  // here. Pinned so a rule added or dropped fails CI rather than quietly making
  // that table wrong, and so the metric count is a number someone has to update
  // deliberately rather than one that drifts as Phase 4 lands its rules. (The
  // Phase 3 gate doc's table is a record of what shipped then; it is not
  // updated, and these numbers have moved past it.)
  it("pins the ruleset split the gate doc reports: 74 rules = 26 page + 38 query + 10 metric", () => {
    const registry = buildRegistry();
    expect(registry.all()).toHaveLength(74);
    expect(registry.byKind("page")).toHaveLength(26);
    expect(registry.byKind("query")).toHaveLength(38);
    // The link-graph four, the two content metrics and hreflang coverage, plus
    // the URL-parameter, redirect-volume and sitemap-structure metrics.
    expect(registry.byKind("metric")).toHaveLength(10);
  });

  it("accounts for all 47 crawl-derived checks: 41 claimed, 3 agent, 3 unclaimed", () => {
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
      "CHECK-03","CHECK-04","CHECK-05","CHECK-06","CHECK-07","CHECK-08","CHECK-09",
      "CHECK-10","CHECK-11","CHECK-12","CHECK-13","CHECK-14","CHECK-15","CHECK-16",
      "CHECK-17","CHECK-18","CHECK-19","CHECK-20","CHECK-21","CHECK-22","CHECK-23",
      "CHECK-24","CHECK-25","CHECK-26","CHECK-27","CHECK-28","CHECK-29",
      "CHECK-30","CHECK-31","CHECK-32",
      "CHECK-33","CHECK-33b",
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

  // The annotation is only worth carrying if it describes the pin above. A
  // check that gains a rule must leave its annotation list in the same commit,
  // or the list is a stale reason for an absence that ended.
  it("the annotation is exactly the unclaimed set, and it says why each is unclaimed", () => {
    const unclaimedList = buildRegistry().unclaimedChecks(CRAWL_CHECK_IDS, AGENT_CHECKS);
    const unclaimed = new Set(unclaimedList);
    for (const c of RENDER_CHECKS)
      expect(unclaimed.has(c), `${c} is claimed — drop it from RENDER_CHECKS`).toBe(true);

    // And the other direction, which is what makes the annotation and the pin
    // one fact rather than two that agree today: EVERY unclaimed check carries
    // a reason. Phase 3 emptied the pin down to two causes — the render pass
    // (Phase 5) and the metric runner (Phase 4) — and Phase 4 discharged the
    // second, so an unclaimed check outside `RENDER_CHECKS` is either a check
    // whose reason nobody wrote down, or a rule that quietly stopped claiming
    // one. Equality on the sorted arrays, so an id on the annotation that is no
    // longer unclaimed fails here too.
    expect(
      [...RENDER_CHECKS].sort(),
      "the pin and its annotation have drifted: every unclaimed check needs a " +
        "reason, and every reason needs a still-unclaimed check",
    ).toEqual([...unclaimedList].sort());
  });
});

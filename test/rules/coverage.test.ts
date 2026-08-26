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
 * the seven below, and each of the seven is annotated with the phase that can
 * answer it: the render pass (Phase 5) or the metric runner (Phase 4).
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
  METRIC_PENDING_CHECKS,
  RENDER_CHECKS,
} from "../../src/rules/registry/registry.js";

describe("checklist coverage", () => {
  it("pins exactly which crawl-derived checks remain unclaimed (the render + metric seven)", () => {
    const unclaimed = buildRegistry().unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS]);
    expect(unclaimed.sort()).toEqual([
      "CHECK-01","CHECK-02","CHECK-08","CHECK-29",
      "CHECK-33","CHECK-33b","CHECK-34",
    ]);
  });

  // The gate document's ruleset table states these three numbers. Pinned here
  // so a rule added or dropped fails CI rather than quietly making that table
  // wrong — and so "0 metric rules" stays a fact about Phase 3 rather than an
  // omission nobody noticed.
  it("pins the ruleset split the gate doc reports: 64 rules = 26 page + 38 query + 0 metric", () => {
    const registry = buildRegistry();
    expect(registry.all()).toHaveLength(64);
    expect(registry.byKind("page")).toHaveLength(26);
    expect(registry.byKind("query")).toHaveLength(38);
    expect(registry.byKind("metric")).toHaveLength(0);
  });

  it("accounts for all 47 crawl-derived checks: 37 claimed, 3 agent, 7 unclaimed", () => {
    // The arithmetic behind the pin above, stated so a drift in the universe
    // itself (an id added to or removed from `CRAWL_CHECK_IDS`) fails here
    // rather than silently changing what "unclaimed" means.
    const registry = buildRegistry();
    const claimed = registry.claimedCheckIds();
    const claimedInUniverse = CRAWL_CHECK_IDS.filter((c) => claimed.has(c));
    const unclaimed = registry.unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS]);

    expect(CRAWL_CHECK_IDS).toHaveLength(47);
    expect(AGENT_CHECKS).toHaveLength(3);
    expect(claimedInUniverse.sort()).toEqual([
      "CHECK-03","CHECK-04","CHECK-05","CHECK-06","CHECK-07","CHECK-09",
      "CHECK-10","CHECK-11","CHECK-12","CHECK-13","CHECK-14","CHECK-15","CHECK-16",
      "CHECK-17","CHECK-18","CHECK-19","CHECK-20","CHECK-21","CHECK-22","CHECK-23",
      "CHECK-24","CHECK-25","CHECK-26","CHECK-27","CHECK-28","CHECK-30","CHECK-31","CHECK-32",
      "CHECK-35","CHECK-36","CHECK-37","CHECK-39","CHECK-40",
      "CHECK-43","CHECK-44","CHECK-45","CHECK-46",
    ]);
    expect(claimedInUniverse.length + AGENT_CHECKS.length + unclaimed.length).toBe(
      CRAWL_CHECK_IDS.length,
    );

    // No rule claims a check the agent owns: an AGENT check with a rule behind
    // it is a rule that always passes (build plan §6).
    for (const agentCheck of AGENT_CHECKS) {
      expect(claimed.has(agentCheck), `${agentCheck} is an AGENT check, not a rule's`).toBe(false);
    }
  });

  // The annotations are only worth carrying if they describe the pin above.
  // A check that gains a rule must leave its annotation list in the same
  // commit, or the list is a stale reason for an absence that ended.
  it("the annotations are exactly the unclaimed set, and each says why it is unclaimed", () => {
    const unclaimedList = buildRegistry().unclaimedChecks(CRAWL_CHECK_IDS, AGENT_CHECKS);
    const unclaimed = new Set(unclaimedList);
    for (const c of RENDER_CHECKS)
      expect(unclaimed.has(c), `${c} is claimed — drop it from RENDER_CHECKS`).toBe(true);
    for (const c of METRIC_PENDING_CHECKS)
      expect(unclaimed.has(c), `${c} is claimed — drop it from METRIC_PENDING_CHECKS`).toBe(true);

    // And the other direction, which is what makes the annotation and the pin
    // one fact rather than two that agree today: EVERY unclaimed check carries
    // a reason. Phase 3 emptied the pin down to these two causes — the render
    // pass (Phase 5) and the metric runner (Phase 4) — so an unclaimed check
    // annotated by neither list is either a check whose reason nobody wrote
    // down, or a rule that quietly stopped claiming one. Equality on the sorted
    // arrays also catches a duplicate across the two lists, which set-wise
    // containment would not.
    expect(
      [...RENDER_CHECKS, ...METRIC_PENDING_CHECKS].sort(),
      "the pin and its annotations have drifted: every unclaimed check needs a " +
        "reason, and every reason needs a still-unclaimed check",
    ).toEqual([...unclaimedList].sort());
  });
});

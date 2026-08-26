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
 * same commit as the rule that claims it. Phase 3 empties this list.
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
  it("pins exactly which crawl-derived checks remain unclaimed (Phase 3 empties this)", () => {
    const unclaimed = buildRegistry().unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS]);
    expect(unclaimed.sort()).toEqual([
      "CHECK-01","CHECK-02","CHECK-03","CHECK-06","CHECK-07","CHECK-08","CHECK-09",
      "CHECK-14","CHECK-15","CHECK-22","CHECK-23",
      "CHECK-24","CHECK-26","CHECK-27","CHECK-28","CHECK-29","CHECK-30","CHECK-32",
      "CHECK-33","CHECK-33b","CHECK-34","CHECK-39","CHECK-43","CHECK-44","CHECK-45","CHECK-46",
    ]);
  });

  it("accounts for all 47 crawl-derived checks: 18 claimed, 3 agent, 26 unclaimed", () => {
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
      "CHECK-04","CHECK-05","CHECK-10","CHECK-11","CHECK-12","CHECK-13","CHECK-16",
      "CHECK-17","CHECK-18","CHECK-19","CHECK-20","CHECK-21","CHECK-25","CHECK-31",
      "CHECK-35","CHECK-36","CHECK-37","CHECK-40",
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
  it("every annotated check is one of the unclaimed ones, and says why it is", () => {
    const unclaimed = new Set(
      buildRegistry().unclaimedChecks(CRAWL_CHECK_IDS, AGENT_CHECKS),
    );
    for (const c of RENDER_CHECKS)
      expect(unclaimed.has(c), `${c} is claimed — drop it from RENDER_CHECKS`).toBe(true);
    for (const c of METRIC_PENDING_CHECKS)
      expect(unclaimed.has(c), `${c} is claimed — drop it from METRIC_PENDING_CHECKS`).toBe(true);
  });
});

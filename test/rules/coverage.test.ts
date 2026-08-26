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
 * metrics took it to the three below — all of them annotated with the one phase
 * left that can answer them: the render pass (Phase 5).
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
  it("pins exactly which crawl-derived checks remain unclaimed (the render three)", () => {
    const unclaimed = buildRegistry().unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS]);
    // CHECK-33 and CHECK-33b left this list with the link-graph metrics, then
    // CHECK-08 (`sitemap.structure`) and CHECK-29 (`url.param-volumes`) with
    // the sitemap and URL metrics. What remains is the render pass alone.
    expect(unclaimed.sort()).toEqual(["CHECK-01","CHECK-02","CHECK-34"]);
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
      buildRegistry()
        .all()
        .filter((r) => r.kind !== "metric")
        .flatMap((r) => r.checkIds),
    );
    for (const agentCheck of AGENT_CHECKS) {
      expect(judging.has(agentCheck), `${agentCheck} is an AGENT check, not a rule's`).toBe(false);
    }
  });

  // The other direction of the same ruling: an agent check a metric claims must
  // be claimed BY A METRIC AND NOTHING ELSE. Asserted positively so the
  // exception above cannot quietly widen — a page rule added to CHECK-38 would
  // fail the guard, and a metric silently dropping the id would fail this.
  it("CHECK-38 is evidenced by metric rules and judged by none", () => {
    const registry = buildRegistry();
    const claimants = registry.all().filter((r) => r.checkIds.includes("CHECK-38"));
    expect(claimants.map((r) => r.id).sort()).toEqual([
      "content.metrics-by-type",
      "content.template-similarity",
    ]);
    for (const r of claimants) expect(r.kind, r.id).toBe("metric");
    // And it stays out of the unclaimed pin: the agent owns it either way.
    expect(registry.unclaimedChecks([...CRAWL_CHECK_IDS], [...AGENT_CHECKS])).not.toContain(
      "CHECK-38",
    );
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

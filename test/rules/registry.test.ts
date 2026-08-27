import { describe, expect, it } from "vitest";
import {
  AGENT_CHECKS,
  CRAWL_CHECK_IDS,
  defineRule,
  Registry,
  RULESET_VERSION,
  RuleDefinitionError,
  type PageRule,
  type Severity,
} from "../../src/rules/registry/registry.js";

const validPageRule = {
  kind: "page" as const,
  id: "title.missing",
  checkIds: ["CHECK-35"],
  category: "on-page" as const,
  severity: "warning" as const,
  title: "Missing title",
  explanation: "The page has no <title> element.",
  howToFix: "Add a unique, descriptive <title>.",
  rulesetVersion: RULESET_VERSION,
  run: () => [],
};

describe("defineRule", () => {
  it("accepts a well-formed rule", () => {
    expect(defineRule(validPageRule)).toBe(validPageRule);
  });
  it("throws on empty checkIds", () => {
    expect(() => defineRule({ ...validPageRule, checkIds: [] }))
      .toThrow(RuleDefinitionError);
  });
  it("throws on malformed id", () => {
    expect(() => defineRule({ ...validPageRule, id: "Title Missing!" }))
      .toThrow(RuleDefinitionError);
  });
  it("throws on missing client copy", () => {
    expect(() => defineRule({ ...validPageRule, howToFix: "" }))
      .toThrow(RuleDefinitionError);
  });

  // The message assertions below pin each case to the specific validation branch
  // it is meant to exercise, so a future change cannot make them pass for the
  // wrong reason (e.g. tripping the id check instead of the checkId check).
  it("throws on a checkId with too few digits", () => {
    expect(() => defineRule({ ...validPageRule, checkIds: ["CHECK-5"] }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, checkIds: ["CHECK-5"] }))
      .toThrow(/bad checkId 'CHECK-5'/);
  });
  it("throws on a lowercase checkId", () => {
    expect(() => defineRule({ ...validPageRule, checkIds: ["check-05"] }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, checkIds: ["check-05"] }))
      .toThrow(/bad checkId 'check-05'/);
  });
  it("throws on a checkId that is valid alongside an invalid one", () => {
    expect(() => defineRule({ ...validPageRule, checkIds: ["CHECK-35", "CHECK-999"] }))
      .toThrow(/bad checkId 'CHECK-999'/);
  });
  it("throws on a severity outside the allowed set", () => {
    expect(() => defineRule({ ...validPageRule, severity: "high" as Severity }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, severity: "high" as Severity }))
      .toThrow(/bad severity/);
  });
  it("throws when run is not a function", () => {
    const notAFunction = { ...validPageRule, run: "nope" as unknown as PageRule["run"] };
    expect(() => defineRule(notAFunction)).toThrow(RuleDefinitionError);
    expect(() => defineRule(notAFunction)).toThrow(/run must be a function/);
  });
  it("accepts a checkId with a letter suffix", () => {
    const suffixed = { ...validPageRule, checkIds: ["CHECK-38a"] };
    expect(defineRule(suffixed)).toBe(suffixed);
  });
  it("throws on an unknown kind", () => {
    expect(() => defineRule({ ...validPageRule, kind: "cosmic" as never }))
      .toThrow(RuleDefinitionError);
    expect(() => defineRule({ ...validPageRule, kind: "cosmic" as never }))
      .toThrow(/bad kind 'cosmic'/);
  });
  it("RuleDefinitionError is recognizable by name", () => {
    try {
      defineRule({ ...validPageRule, id: "BAD ID" });
      throw new Error("no throw");
    } catch (e) {
      expect((e as Error).name).toBe("RuleDefinitionError");
    }
  });
});

describe("Registry", () => {
  it("loads zero rules without error and reports full unclaimed list", () => {
    const r = new Registry();
    expect(r.all()).toEqual([]);
    expect(r.unclaimedChecks(["CHECK-35", "CHECK-38"], ["CHECK-38"]))
      .toEqual(["CHECK-35"]);
  });
  it("rejects duplicate rule ids", () => {
    const r = new Registry();
    r.register(validPageRule);
    expect(() => r.register(validPageRule)).toThrow(RuleDefinitionError);
  });
  it("claims checks through registered rules", () => {
    const r = new Registry();
    r.register(validPageRule);
    expect(r.unclaimedChecks(["CHECK-35"], [])).toEqual([]);
  });
  it("byKind narrows and filters", () => {
    const r = new Registry();
    r.register(validPageRule);
    expect(r.byKind("page").map((x) => x.id)).toEqual(["title.missing"]);
    expect(r.byKind("query")).toEqual([]);
  });
});

describe("check universe", () => {
  it("exports the crawl-derived check universe and agent list", () => {
    expect(CRAWL_CHECK_IDS).toHaveLength(47);
    expect(CRAWL_CHECK_IDS).toContain("CHECK-33b");
    expect(AGENT_CHECKS).toEqual(["CHECK-38", "CHECK-41", "CHECK-42"]);
    // 0.4.0: the render pass's four finding rules and its coverage metric
    // changed what the ruleset says about a site, so a finding read back later
    // can be traced to the ruleset that produced it rather than to a version
    // that predates the render diff.
    expect(RULESET_VERSION).toBe("0.4.0");
  });
  it("every listed check id is a well-formed CHECK-NN and unique", () => {
    expect(new Set(CRAWL_CHECK_IDS).size).toBe(CRAWL_CHECK_IDS.length);
    for (const c of CRAWL_CHECK_IDS) expect(c).toMatch(/^CHECK-\d{2}[a-z]?$/);
  });
  it("every agent check is part of the crawl-derived universe", () => {
    for (const c of AGENT_CHECKS) expect(CRAWL_CHECK_IDS).toContain(c);
  });
});

/**
 * The annotations that said WHY a check had no rule behind it, so the coverage
 * pin's entries were explained rather than merely counted. There are none left:
 * `METRIC_PENDING_CHECKS` went with Phase 4's metric rules and `RENDER_CHECKS`
 * with Phase 5's render diff rules, each deleted by the phase that claimed its
 * ids — an annotation with nothing to annotate is a reason nobody needs.
 *
 * What survives is the property those lists were checked FOR, asserted against
 * the one list still standing. `AGENT_CHECKS` is not an annotation of the same
 * kind: those three are judgement and will never have a finding rule, so they
 * are excluded from the pin permanently rather than pending a phase.
 */
describe("check annotations", () => {
  it("the agent list is well-formed and inside the crawl-derived universe", () => {
    expect(new Set(AGENT_CHECKS).size, "AGENT_CHECKS repeats an id").toBe(AGENT_CHECKS.length);
    for (const c of AGENT_CHECKS) expect(CRAWL_CHECK_IDS, c).toContain(c);
  });
});

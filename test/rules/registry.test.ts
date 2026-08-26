import { describe, expect, it } from "vitest";
import {
  AGENT_CHECKS,
  CRAWL_CHECK_IDS,
  RENDER_CHECKS,
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
    expect(RULESET_VERSION).toBe("0.2.0");
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
 * The one annotation left that says WHY a check has no rule behind it, so the
 * coverage pin's remaining entries are explained rather than merely counted:
 * `RENDER_CHECKS` wait on the render pass. `METRIC_PENDING_CHECKS` was the
 * other, and Phase 4 deleted it — its four ids are claimed by metric rules, and
 * an annotation with nothing to annotate is a reason nobody needs (see the
 * `RENDER_CHECKS` doc comment). Neither list is `AGENT_CHECKS` — those are
 * judgement, and will never have a rule.
 */
describe("check annotations", () => {
  it("exports the render-gated list", () => {
    expect(RENDER_CHECKS).toEqual(["CHECK-01", "CHECK-02", "CHECK-34"]);
  });

  it("every annotated check is part of the crawl-derived universe", () => {
    for (const c of RENDER_CHECKS) expect(CRAWL_CHECK_IDS, c).toContain(c);
  });

  // Disjoint at runtime, not just by inspection: a check that appears on two
  // lists claims two different reasons for having no rule, and one of them is
  // a lie the coverage pin would carry forward.
  it("the annotation lists are pairwise disjoint", () => {
    const lists: [string, readonly string[]][] = [
      ["AGENT_CHECKS", AGENT_CHECKS],
      ["RENDER_CHECKS", RENDER_CHECKS],
    ];
    for (const [nameA, a] of lists) {
      expect(new Set(a).size, `${nameA} repeats an id`).toBe(a.length);
      for (const [nameB, b] of lists) {
        if (nameA === nameB) continue;
        for (const c of a) expect(b, `${c} is on both ${nameA} and ${nameB}`).not.toContain(c);
      }
    }
  });
});

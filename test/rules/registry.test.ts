import { describe, expect, it } from "vitest";
import {
  defineRule,
  Registry,
  RuleDefinitionError,
  type PageRule,
  type Severity,
} from "../../src/rules/registry/registry.js";

const validPageRule = {
  kind: "page" as const,
  id: "title.missing",
  checkIds: ["CHECK-35"],
  category: "on-page",
  severity: "warning" as const,
  title: "Missing title",
  explanation: "The page has no <title> element.",
  howToFix: "Add a unique, descriptive <title>.",
  rulesetVersion: "0.1.0",
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
});

import { describe, expect, it } from "vitest";

import { buildRegistry } from "../../src/rules/index.js";
import {
  defineRule,
  perScope,
  RULESET_VERSION,
  type Priority,
  type TriageLookup,
} from "../../src/rules/registry/registry.js";
import { TRIAGE, triageFor } from "../../src/rules/registry/triage.js";

/**
 * The triage table (Phase 27a): every rule that finds carries an issue type and
 * a priority beside its severity, from ONE table, src/rules/registry/triage.ts.
 * Metric rules produce no findings and carry neither; NOT MEASURED markers are
 * warning / low by definition (a check that could not run is something to look
 * at, not a defect on the site).
 */
const RULES = buildRegistry().all();

describe("triage", () => {
  it("gives every page and query rule a type and priority", () => {
    for (const r of RULES.filter((r) => r.kind !== "metric")) {
      expect(["issue", "warning", "opportunity"], r.id).toContain(r.type);
      expect(["high", "medium", "low"], r.id).toContain(r.priority);
    }
  });

  it("gives metric rules neither, and has no row for them", () => {
    for (const r of RULES.filter((r) => r.kind === "metric")) {
      expect(r.type, r.id).toBeUndefined();
      expect(r.priority, r.id).toBeUndefined();
      expect(TRIAGE[r.id], r.id).toBeUndefined();
    }
  });

  it("has no row for a rule the registry lacks", () => {
    const ids = new Set(RULES.map((r) => r.id));
    expect(Object.keys(TRIAGE).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("files every marker as warning / low", () => {
    for (const r of RULES.filter((r) => r.marker !== undefined)) {
      expect([r.type, r.priority], r.id).toEqual(["warning", "low"]);
    }
  });

  it("keeps the rows in rule-id order, one per page and query rule", () => {
    const keys = Object.keys(TRIAGE);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(RULES.filter((r) => r.kind !== "metric").length);
  });

  it("names the rule a lookup misses, as copyFor does", () => {
    expect(triageFor("title.missing")).toEqual({
      type: TRIAGE["title.missing"]!.type,
      priority: TRIAGE["title.missing"]!.priority,
    });
    expect(() => triageFor("no.such-rule")).toThrow(/no\.such-rule/);
  });

  it("refuses a metric rule with a triage row and a marker with other triage", () => {
    const metric = {
      kind: "metric" as const,
      id: "test.metric-with-triage",
      checkIds: ["CHECK-83"],
      category: "crawl" as const,
      severity: "info" as const,
      title: "Test: metric",
      explanation: "A table of counts.",
      howToFix: "Read it.",
      rulesetVersion: RULESET_VERSION,
      table: perScope("Scope", [{ key: "n", label: "N" }]),
      run: async () => [],
    };
    const rowFor =
      (id: string, row: ReturnType<TriageLookup>): TriageLookup =>
      (ruleId) =>
        ruleId === id ? row : undefined;

    expect(() =>
      defineRule(metric, rowFor(metric.id, { type: "warning", priority: "low" })),
    ).toThrow(/metric/);
    // Without a row the same metric rule is accepted and stays untriaged.
    const plain = defineRule({ ...metric }, rowFor("other", undefined));
    expect([plain.type, plain.priority]).toEqual([undefined, undefined]);

    const marker = {
      kind: "page" as const,
      id: "test.marker-with-triage",
      checkIds: ["CHECK-83"],
      category: "crawl" as const,
      severity: "info" as const,
      title: "Test: marker",
      explanation: "A check that could not run.",
      howToFix: "Re-crawl.",
      rulesetVersion: RULESET_VERSION,
      marker: "a crawl condition the check cannot judge",
      columns: [],
      run: () => [],
    };
    expect(() =>
      defineRule({ ...marker }, rowFor(marker.id, { type: "issue", priority: "high" })),
    ).toThrow(/marker/);
    const filed = defineRule({ ...marker }, rowFor(marker.id, { type: "warning", priority: "low" }));
    expect([filed.type, filed.priority]).toEqual(["warning", "low"]);
  });

  it("refuses a page or query rule with no row, naming it", () => {
    const orphan = {
      kind: "query" as const,
      id: "test.no-triage-row",
      checkIds: ["CHECK-01"],
      category: "technical" as const,
      severity: "info" as const,
      title: "Test: rule with no row",
      explanation: "Nothing.",
      howToFix: "Nothing.",
      rulesetVersion: RULESET_VERSION,
      columns: [],
      run: async () => [],
    };
    expect(() => defineRule(orphan)).toThrow(/test\.no-triage-row.*triage\.ts/);
  });

  it("refuses a definition that writes its own triage against the table", () => {
    const row = TRIAGE["title.missing"]!;
    const other: Priority = row.priority === "low" ? "high" : "low";
    const rule = buildRegistry().byKind("page").find((r) => r.id === "title.missing")!;
    // The defined rule re-checks clean (that is what `Registry.register` does);
    // the same rule claiming another priority is refused, not overwritten.
    expect(defineRule(rule)).toEqual(rule);
    expect(() => defineRule({ ...rule, priority: other })).toThrow(/triage\.ts/);
  });
});

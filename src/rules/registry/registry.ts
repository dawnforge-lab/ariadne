import type { AnyRule } from "./types.js";
export * from "./types.js";

export class RuleDefinitionError extends Error {
  // Explicit so the name survives transpilation and minification: callers that
  // cannot `instanceof` across module boundaries match on `error.name`.
  override name = "RuleDefinitionError";
}

const RULE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const CHECK_ID = /^CHECK-\d{2}[a-z]?$/;
/**
 * The rule kinds `defineRule` accepts. `satisfies` ties the list to the type:
 * a misspelled or retired kind here stops compiling rather than becoming a
 * value no rule can ever have. The `.includes` call below widens it back to
 * `string`, because the value being validated arrives from JavaScript that the
 * type system did not check.
 */
const KINDS = ["page", "query", "metric"] as const satisfies readonly AnyRule["kind"][];

/**
 * The version stamped on every rule and on the `crawls` row. Bump it whenever a
 * rule's verdict or copy changes, so a finding can be traced to the ruleset
 * that produced it. One constant — `loop.ts` imports it rather than restating.
 */
// 0.9.0: Phase 12, on three grounds — and ALL are named because this constant
// stamps more than a verdict. The paragraph above is the contract: a finding is
// traced to the ruleset that produced it, and `rules_catalog` serves the COPY
// stamped with this same constant, so text a client reads is part of what a
// version identifies.
//
//  1. `resources.not-fetched` (T2). A marker a crawl could not receive before: a
//     crawl that recorded every file its pages point at and asked about none of
//     them — `fetchResources: false`, or a pass interrupted before its first
//     request — met no finding at all, and a re-judge at 0.9.0 gives it one. It
//     is ADDITIVE by construction: the sibling the Phase 11 gate ruled on
//     (docs/gates/phase-11.md §10.3), never a widened `resources.not-recorded`,
//     whose condition moving would have been a verdict change on a rule that
//     already exists.
//  2. `resources.broken` and `resources.uncached`'s explanations (T1). Both now
//     name the `robots_unreachable` class the fetch pass writes, in the
//     unknown-bucket sentence a client reads. The verdicts did not move; what
//     the ruleset SAYS did.
//  3. `render.coverage` gained a column and its explanation gained the sentence
//     that reads it (T4): `renderPassEvidence`, which says whether the four
//     recomputed selection numbers describe a decision that was taken or one
//     that would be. A metric's SHAPE changed and so did the copy served with
//     it — the same ground as (2), on the row an auditor reads before quoting
//     any JavaScript finding (docs/gates/phase-11.md §6.3).
//
// ONE BUMP FOR THE PHASE, not one per task: 0.9.0 is stamped by T2 and covers
// every ground above. A crawl re-judged at it gets the marker, the two reworded
// resource explanations and the new coverage column together.
//
// 0.8.0: Phase 11. Five verdicts a page or a site could not receive before —
// `resources.broken`, `images.oversized`, `images.legacy-format`,
// `resources.uncached` and the `resources.not-recorded` marker — plus the
// `page.weight` table. They read `resources` and `page_resources`, which
// migration 0013 created and the resource fetch pass fills, so a crawl re-judged
// at 0.8.0 can gain findings it did not have and a crawl from before 0013 gains
// the marker saying why it cannot.
//
// 0.7.0: `structure.deep-page` moved to `click_depth` — a rule silent on real
// sites became reachable, so a re-judged crawl can change verdict.
export const RULESET_VERSION = "0.9.0";

/**
 * The 47 crawl-derived checks (sf-audit checklist, Pre-Crawl + sections 1–11):
 * the universe a crawl can speak to. CI compares this against the registry's
 * claimed checks, so an unclaimed check is visible rather than silently absent.
 */
export const CRAWL_CHECK_IDS: readonly string[] = [
  "CHECK-01","CHECK-02","CHECK-03","CHECK-04","CHECK-05","CHECK-06","CHECK-07",
  "CHECK-08","CHECK-09","CHECK-10","CHECK-11","CHECK-12","CHECK-13","CHECK-14",
  "CHECK-15","CHECK-16","CHECK-17","CHECK-18","CHECK-19","CHECK-20","CHECK-21",
  "CHECK-22","CHECK-23","CHECK-24","CHECK-25","CHECK-26","CHECK-27","CHECK-28",
  "CHECK-29","CHECK-30","CHECK-31","CHECK-32","CHECK-33","CHECK-33b","CHECK-34",
  "CHECK-35","CHECK-36","CHECK-37","CHECK-38","CHECK-39","CHECK-40","CHECK-41",
  "CHECK-42","CHECK-43","CHECK-44","CHECK-45","CHECK-46",
];

/**
 * Judgement checks — never rules (build plan §6: no rule that always passes).
 *
 * THE ONLY ANNOTATION LEFT, and the only reason a crawl-derived check has no
 * finding rule behind it. Two others stood beside it and both are gone, each
 * deleted by the phase that discharged it: `METRIC_PENDING_CHECKS` (CHECK-08,
 * CHECK-29, CHECK-33, CHECK-33b — site-wide numbers rather than per-page faults)
 * left with Phase 4's metric rules, and `RENDER_CHECKS` (CHECK-01, CHECK-02,
 * CHECK-34 — questions about what a page shows AFTER its JavaScript has run)
 * with Phase 5's render diff rules, which are the pass that made those three
 * answerable at all. An annotation with nothing to annotate is a reason nobody
 * needs; a future check waiting on a future phase arrives with the rule that
 * claims it rather than with a list to join.
 *
 * The coverage pin is now empty in consequence: `unclaimedChecks(…)` returns
 * `[]`, which is what `test/rules/coverage.test.ts` asserts.
 */
export const AGENT_CHECKS: readonly string[] = ["CHECK-38", "CHECK-41", "CHECK-42"];

export function defineRule<T extends AnyRule>(rule: T): T {
  const fail = (msg: string): never => {
    throw new RuleDefinitionError(`rule '${rule.id ?? "<no id>"}': ${msg}`);
  };
  if (!rule.id || !RULE_ID.test(rule.id)) fail("id must be kebab/dot lowercase");
  if (!Array.isArray(rule.checkIds) || rule.checkIds.length === 0)
    fail("checkIds must claim at least one CHECK-NN");
  for (const c of rule.checkIds) if (!CHECK_ID.test(c)) fail(`bad checkId '${c}'`);
  if (!["critical", "warning", "info"].includes(rule.severity)) fail("bad severity");
  if (!(KINDS as readonly string[]).includes(rule.kind)) fail(`bad kind '${rule.kind}'`);
  for (const field of ["category", "title", "explanation", "howToFix", "rulesetVersion"] as const)
    if (!rule[field]) fail(`${field} is required (client-facing copy is not optional)`);
  if (typeof rule.run !== "function") fail("run must be a function");
  return rule;
}

export class Registry {
  private rules = new Map<string, AnyRule>();

  register(rule: AnyRule): void {
    defineRule(rule);
    if (this.rules.has(rule.id))
      throw new RuleDefinitionError(`duplicate rule id '${rule.id}'`);
    this.rules.set(rule.id, rule);
  }
  all(): AnyRule[] { return [...this.rules.values()]; }
  byKind<K extends AnyRule["kind"]>(kind: K): Extract<AnyRule, { kind: K }>[] {
    return this.all().filter((r): r is Extract<AnyRule, { kind: K }> => r.kind === kind);
  }
  claimedCheckIds(): Set<string> {
    return new Set(this.all().flatMap((r) => r.checkIds));
  }
  unclaimedChecks(allCheckIds: readonly string[], agentChecks: readonly string[]): string[] {
    const claimed = this.claimedCheckIds();
    const agent = new Set(agentChecks);
    return allCheckIds.filter((c) => !claimed.has(c) && !agent.has(c));
  }
}

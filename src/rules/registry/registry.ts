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
export const RULESET_VERSION = "0.2.0";

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

/** Judgement checks — never rules (build plan §6: no rule that always passes). */
export const AGENT_CHECKS: readonly string[] = ["CHECK-38", "CHECK-41", "CHECK-42"];

/**
 * Checks that need the render pass before a rule can speak to them: what a
 * page shows after its JavaScript has run is not in the raw HTML the crawler
 * stores today. A rule written against the unrendered body would report the
 * empty shell as the page, which is worse than reporting nothing.
 */
export const RENDER_CHECKS: readonly string[] = ["CHECK-01", "CHECK-02", "CHECK-34"];

/**
 * Checks whose answer is a site-wide number rather than a per-page fault —
 * they belong to the metric rules. The runner drives the metric kind; no
 * metric rule claims these ids yet. Listed so the coverage pin's remainder
 * says *why* each check is still unclaimed instead of leaving a reader to
 * guess.
 */
export const METRIC_PENDING_CHECKS: readonly string[] = [
  "CHECK-08", "CHECK-29", "CHECK-33", "CHECK-33b",
];

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

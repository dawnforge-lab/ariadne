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
// 0.14.0: Phase 19, the audit accuracy pass
// (docs/superpowers/specs/2026-09-09-audit-accuracy-pass-design.md), on FOUR
// grounds. (1) Verdicts MOVED: `content.exact-duplicate` and
// `content.near-duplicate` no longer count a page canonicalised elsewhere, and
// every hreflang rule ignores such a page as declarer and as target — two
// parameter variants on a real crawl were reported critical for the state the
// fix text prescribes. (2) A measurement CHANGED: `content.near-duplicate`
// pairs on `main_simhash` (the fingerprint of the main content, migration
// 0018) with both pages at least 50 words of their own, instead of the
// whole-text `simhash` that ~900 words of chrome dominated; on a crawl with no
// main-content fingerprint the rule is silent and `content.near-duplicate-
// skipped` says why. (3) Rules ADDED: `links.to-server-error` (critical),
// `hreflang.missing-self-reference` (warning), and two NOT MEASURED markers,
// `hreflang.alternates-not-crawled` and `content.near-duplicate-skipped`
// (info). 100 rules: 28 critical / 25 warning / 47 info. (4) COPY changed on
// 26 rules and every marker reason, under the rubric test in
// test/rules/copy.test.ts; `content.placeholder`'s evidence gains the snippet.
// Nothing is backfilled: an older crawl re-judged at 0.14.0 loses the
// canonical-variant duplicates (they were never duplicates), gains the two
// markers where they apply, and keeps every other finding.
//
// 0.13.0: Phase 17, on THREE grounds — one rule added, one verdict MOVED, and
// copy changed. The 5xx re-verification pass
// (docs/superpowers/specs/2026-09-08-5xx-recheck-design.md) fetches every
// `server_error` page exactly once more at crawl end and writes the second
// observation beside the first, and the ruleset now reads it:
//
//  1. `http.server-error-transient` (warning), a verdict no page could receive
//     before: a 5xx whose second look got a non-5xx answer FROM THE SITE.
//  2. `http.server-error` no longer fires on those pages. That is the verdict
//     MOVE, and the only one: a page that was `critical` at 0.12.0 is a
//     `warning` at 0.13.0 when — and only when — a recheck cleared it. The two
//     rules are mutually exclusive and jointly exhaustive over
//     `fetch_class = 'server_error'`, so no 5xx page goes silent.
//  3. `http.server-error`'s explanation and howToFix, reworded to name the
//     second observation and to say plainly that a finding whose `recheck` is
//     "not run" has not been re-verified. Both rules' evidence carries the
//     recheck columns.
//
// Totals move to 27 critical / 24 warning / 45 info over 96 rules.
//
// THE MIGRATION STORY, because this is the first bump that could have lost an
// Error and does not: NOTHING IS BACKFILLED. The recheck columns are null on
// every row written before migration 0016, and `recheckCleared` is false on a
// null class, so an older crawl re-judged at 0.13.0 reports exactly what it
// reported at 0.12.0 — every Error still an Error — with `recheck: "not run"`
// added to the evidence saying why it was never re-verified. A finding moves
// band only on a crawl that actually took a second look and got an answer.
//
// 0.12.0: Phase 16, on ONE ground — a severity recalibration, and nothing else.
// 29 of the 95 rules move band: 23 from `warning` to `critical`, 5 from
// `info` to `warning`, and `crawl.blocked` from `warning` to `info` as the tenth
// NOT MEASURED marker (owner-ruled: a crawl refusal is a fact about our crawl,
// not a site issue), leaving 27 critical / 23 warning / 45 info. The rules,
// the rubric they were classified against and the per-rule rationale are
// docs/superpowers/specs/2026-09-08-severity-recalibration-design.md §1-3;
// that document's §3 is the authority for which ids moved.
//
// This is the cleanest bump the file has had, and the property worth stating is
// what it does NOT change: no finding's existence and no finding's evidence. The
// same crawl re-judged at 0.12.0 produces the identical set of findings, with the
// `severity` column of those 29 rules' rows moved and every other column — id,
// scope, url, evidence, copy — byte-identical. No rule was added, retired,
// rewritten or rescoped; the one copy edit is `crawl.blocked`'s title and
// explanation, reworded to say it is a crawl outcome rather than a defect.
//
// It is still a bump, because the version stamps what the ruleset SAYS about a
// site and this changes that: a crawl judged at 0.11.0 and one judged at 0.12.0
// are not row-comparable on severity, and anything rolled up FROM severity moves
// with them. `site.health`'s `urlsCritical` is the one to watch — it meant
// "pages that are mechanically broken" at 0.11.0 and means "pages carrying a
// first-fix SEO defect" at 0.12.0, so a gauge drawn from it needs the ruleset
// version beside the number. Stored findings keep the severity their ruleset
// gave them; nothing is backfilled, which is what `test/api/query.test.ts`'s
// cross-ruleset machinery exists to report.
//
// 0.11.0: Phase 14 Task 1, on ONE ground. `resources.partial-unknown` (T1), the
// fourth and last resource marker. A crawl whose census is a MIX — some rows
// `null` (never asked about), the rest a decided unknown class (`refused`,
// `robots_denied`, `robots_unreachable`, `fetch_error`), and not one `ok` or
// broken row — met NO finding at all: the four judging rules gate on an `ok`
// class and go quiet, `resources.broken` has no broken row, and the three
// existing markers exclude it by construction (`seen == 0`, every row null,
// every row a decided unknown — this is the mix none of them match). It closes
// the window phase-13.md §8 pointer 1 named, one layer in from the §10.1 window
// `resources.all-unknown` closed. ADDITIVE by the same argument all three
// siblings are — a crawl gains a finding it could not receive before, no existing
// verdict moves — which is why the bump belongs here. No copy of any existing
// rule changed.
//
// 0.10.0: Phase 13 Task 2, on ONE ground. `resources.all-unknown` (T2), the
// third and last resource marker. A crawl whose every resource row landed in an
// unknown class — `refused`, `robots_denied`, `robots_unreachable`,
// `fetch_error`, and not one `ok` or broken or unasked row — met NO finding at
// all: the four judging rules gate on an `ok` class and go quiet, the two
// existing markers exclude it by construction (their conditions are `seen == 0`
// and `null == seen`), and a re-judge at 0.10.0 gives that crawl a marker. It is
// ADDITIVE by the same argument its two siblings are — a crawl gains a finding
// it could not receive before, no existing verdict moves — which is why the bump
// belongs here rather than being a change a stored finding already carries. It
// closes the window Phase 12 stated and left open (docs/gates/phase-12.md
// §10.1): the closure named "another marker, another rule, another bump", and
// this is that bump. No copy of any existing rule changed.
//
// 0.9.0: Phase 12, on three grounds — and ALL are named because this constant
// stamps more than a verdict. The paragraph above is the contract: a finding is
// traced to the ruleset that produced it, and `rules_catalog` serves the COPY
// stamped with this same constant, so text a client reads is part of what a
// version identifies.
//
//  1. `resources.not-fetched` (T2). A marker a crawl could not receive before: a
//     crawl that recorded every file its pages point at and asked about none of
//     them — `fetchResources: false`, a pass interrupted before its first
//     request, or a `maxResources` budget that claimed every row before anything
//     was asked — met no finding at all, and a re-judge at 0.9.0 gives it one. It
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
export const RULESET_VERSION = "0.14.0";

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
  // A NOT MEASURED marker declares itself with the `marker` flag, whose value is
  // the reason it exists. The field is optional, but PRESENT-AND-EMPTY is a flag
  // with no reason — the exact drift the guard derives this set to prevent — so
  // it is refused here rather than reaching the registry as a silent marker.
  if (rule.marker !== undefined && (typeof rule.marker !== "string" || rule.marker.trim() === ""))
    fail("marker, when present, must be a non-empty reason string");
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

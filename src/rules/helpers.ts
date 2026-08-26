import type { Db } from "../db/client.js";
import { copyFor } from "./registry/copy/index.js";
import { defineRule, RULESET_VERSION } from "./registry/registry.js";
import type {
  Finding,
  Metric,
  MetricRule,
  PageRecord,
  PageRule,
  RuleCategory,
  Severity,
} from "./registry/types.js";

/**
 * A page whose on-page signals are meaningful: fetched OK as HTML with a 200.
 *
 * Takes the two columns it reads rather than a whole `PageRecord`, so a rule
 * holding a narrower projection of `pages` — the hreflang join rules select
 * four columns per target, not the row — asks the same question through the
 * same function instead of restating the condition beside it.
 */
export function isAuditable(page: Pick<PageRecord, "fetchClass" | "statusCode">): boolean {
  return page.fetchClass === "ok" && page.statusCode === 200;
}

/**
 * Whether a stored string actually declares something. A tag that reached the
 * database as `""` or `"   "` — `<title> </title>`, `<link rel=canonical
 * href="">`, an empty robots meta — declares nothing, and reading it as a
 * declaration hides the page from the rule that reports its absence while
 * every other rule quietly accepts it: the always-passes hole hard rule 1
 * forbids. Blank is "not declared", everywhere in the rule layer.
 */
export function present(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/**
 * The identity a finding is stamped with. `pageRule` hands this to the rule
 * body so the id and severity are written once, in the rule's definition,
 * rather than restated inside it where they can drift.
 */
export interface RuleIdentity {
  id: string;
  severity: Severity;
}

export function finding(
  rule: RuleIdentity,
  page: PageRecord,
  evidence: Record<string, unknown>,
): Finding {
  return {
    ruleId: rule.id,
    pageId: page.id,
    pageUrl: page.url,
    severity: rule.severity,
    evidence,
    dedupeKey: page.url,
  };
}

/**
 * The query rules' twin of `finding`. A query rule builds its findings from
 * SQL rows rather than from a `pages` record, so it names the page itself —
 * but the id and severity still come from the rule's own identity rather than
 * being restated per finding, which is where the two can drift apart.
 */
export function queryFinding(
  self: RuleIdentity,
  f: {
    pageId: string | null;
    pageUrl: string | null;
    evidence: Record<string, unknown>;
    dedupeKey: string;
  },
): Finding {
  // Destructured field by field rather than spread: a spread of `f` — wherever
  // it sits in the literal — carries whatever else the caller's object holds,
  // and a `ruleId` or `severity` that arrived from a SQL row (`select *` into
  // the payload, say) would either override the rule's own identity or ride
  // along into the `issues` row. The identity is single-sourced from `self`,
  // and only the four fields named here come from the caller.
  const { pageId, pageUrl, evidence, dedupeKey } = f;
  return { ruleId: self.id, pageId, pageUrl, severity: self.severity, evidence, dedupeKey };
}

/**
 * The metric rules' twin of `queryFinding`. A metric rule produces numbers
 * rather than accusations, so there is no page and no severity to carry — but
 * the identity question is the same one, and sharper: the runner deletes a
 * metric rule's rows for the crawl with `metric_id = <the rule's id>` before
 * inserting its fresh set, so a row filed under any other metric id would never
 * be recomputed and never removed. `metricId` therefore comes from `self` and
 * from nowhere else.
 *
 * The parameter is a discriminated union rather than one shape with an optional
 * `scopeValue`, because the two scopes ask for different things and the optional
 * spelling let a caller write both of the rows the runner refuses:
 *
 *   - `page_type` REQUIRES a name. A cohort row is the answer for one group of
 *     pages; without a name it identifies no group, and the empty string is
 *     already spoken for — it is what a site row stores in the composite primary
 *     key `(crawl_id, metric_id, scope, scope_value)`.
 *   - `site` ACCEPTS no name. There is one site per crawl, so a scope value on
 *     it would key a second "site" row and answer the same question twice.
 *
 * Both are now unrepresentable for a caller that uses this helper. The runner
 * checks them again at the JavaScript boundary, where a rule body's return value
 * is not something the type system has seen.
 */
/**
 * The identity a metric row is stamped with — an id and nothing else.
 *
 * A metric carries no severity (it accuses no one) and names no page, so where
 * `RuleIdentity` has two fields this has one. It exists as a named type all the
 * same, because it is the thing `metricRow` refuses to take from anywhere but
 * the rule's own definition: the runner deletes a metric rule's rows by
 * `metric_id = <the rule's id>`, so a row filed under any other id is a row
 * nothing ever recomputes or removes.
 */
export interface MetricIdentity {
  id: string;
}

export function metricRow(
  self: MetricIdentity,
  m:
    | { scope: "site"; value: Record<string, unknown> }
    | { scope: "page_type"; scopeValue: string; value: Record<string, unknown> },
): Metric {
  // Each field named rather than spread, for `queryFinding`'s reason: a spread
  // of `m` would carry whatever else the caller's object holds — a `metricId`
  // read out of a SQL row, say — either overriding the rule's own identity or
  // riding along into the `metrics` row.
  if (m.scope === "site") {
    return { metricId: self.id, scope: "site", scopeValue: "", value: m.value };
  }
  return { metricId: self.id, scope: "page_type", scopeValue: m.scopeValue, value: m.value };
}

/**
 * Define a page rule: the registry metadata, the client-facing copy (which
 * `copyFor` throws for if it is missing — a rule cannot ship untitled) and the
 * ruleset version, assembled around a body that receives the page and the
 * rule's own identity.
 *
 * One definition, imported by every page-rule file, so the shape of a rule is
 * stated in a single place.
 */
export function pageRule(
  id: string,
  checkIds: string[],
  category: RuleCategory,
  severity: Severity,
  run: (page: PageRecord, self: RuleIdentity) => Finding[],
): PageRule {
  const self: RuleIdentity = { id, severity };
  return defineRule<PageRule>({
    kind: "page",
    id,
    checkIds,
    category,
    severity,
    ...copyFor(id),
    rulesetVersion: RULESET_VERSION,
    run: (page) => run(page, self),
  });
}

/**
 * Define a metric rule: `pageRule`'s twin for the kind that produces numbers.
 *
 * Same job — registry metadata, the copy `copyFor` throws for if it is missing,
 * the ruleset version — and the same reason to be a factory rather than four
 * spelled-out object literals: the id appears in three places that must agree
 * (the registry key, the `copyFor` lookup, and the `metricId` stamped on every
 * row the rule emits), and here it is written once and handed to the body as
 * `self`. A rule that restated its own id in a `metricRow` call could drift
 * from the id the runner deletes by, which is the one drift the metrics table
 * cannot survive: rows nothing owns are never recomputed and never removed.
 *
 * `severity` is not a parameter, unlike `pageRule`'s. A metric states what was
 * counted; it accuses the site of nothing, and the judgement is the agent's —
 * so `info` is not a default here, it is the only value the kind can have.
 */
export function metricRule(
  id: string,
  checkIds: string[],
  category: RuleCategory,
  run: (db: Db, crawlId: string, self: MetricIdentity) => Promise<Metric[]>,
): MetricRule {
  const self: MetricIdentity = { id };
  return defineRule<MetricRule>({
    kind: "metric",
    id,
    checkIds,
    category,
    severity: "info",
    ...copyFor(id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId) => run(db, crawlId, self),
  });
}

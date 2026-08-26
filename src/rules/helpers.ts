import { copyFor } from "./registry/copy/index.js";
import { defineRule, RULESET_VERSION } from "./registry/registry.js";
import type {
  Finding,
  PageRecord,
  PageRule,
  RuleCategory,
  Severity,
} from "./registry/types.js";

/** A page whose on-page signals are meaningful: fetched OK as HTML with a 200. */
export function isAuditable(page: PageRecord): boolean {
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
  return { ruleId: self.id, severity: self.severity, ...f };
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

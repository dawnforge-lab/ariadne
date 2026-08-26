import type { Db } from "../../db/client.js";
import type { pages } from "../../db/schema.js";

export type Severity = "critical" | "warning" | "info";
export type PageRecord = typeof pages.$inferSelect;

export interface Finding {
  ruleId: string;
  pageId: string | null;
  pageUrl: string | null;
  severity: Severity;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

export interface Metric {
  metricId: string;
  scope: "site" | "page_type";
  scopeValue: string;
  value: Record<string, unknown>;
}

/**
 * The report's top-level grouping. A closed union rather than a free string:
 * the categories are what the report and the action plan sort findings into,
 * so a one-off spelling ("structure", "mobile") is a group of one nobody asked
 * for. A new rule belongs in one of these; if it genuinely does not, the union
 * is what gets extended, deliberately, in one place.
 */
export type RuleCategory =
  | "on-page"
  | "canonical"
  | "indexability"
  | "hreflang"
  | "technical"
  | "crawl"
  | "redirects"
  | "links"
  | "sitemap"
  | "url"
  | "host"
  | "content"
  | "structured-data";

interface RuleMeta {
  id: string;               // 'canonical.non-200-target'
  checkIds: string[];       // ['CHECK-19'] — traces to the sf-audit checklist
  category: RuleCategory;
  severity: Severity;
  title: string;
  explanation: string;      // client-facing
  howToFix: string;         // client-facing
  rulesetVersion: string;
}

export interface PageRule extends RuleMeta {
  kind: "page";
  run: (page: PageRecord) => Finding[];
}
export interface QueryRule extends RuleMeta {
  kind: "query";
  run: (db: Db, crawlId: string) => Promise<Finding[]>;
}
export interface MetricRule extends RuleMeta {
  kind: "metric";
  run: (db: Db, crawlId: string) => Promise<Metric[]>;
}
export type AnyRule = PageRule | QueryRule | MetricRule;

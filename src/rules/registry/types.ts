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

interface RuleMeta {
  id: string;               // 'canonical.non-200-target'
  checkIds: string[];       // ['CHECK-19'] — traces to the sf-audit checklist
  category: string;
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

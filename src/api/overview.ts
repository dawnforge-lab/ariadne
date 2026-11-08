/**
 * The Issues Overview (Phase 27a T8): one row per rule, with the crawl's
 * judgement applied — what `issues_overview` serves as JSON over MCP and HTTP
 * and as the `issues_overview` CSV view.
 *
 * ONE BUILDER, TWO SURFACES. The JSON and the CSV are the same function's
 * answer, so they can never disagree on a row or an order.
 *
 * Hard rule 3: the findings are counted by ONE `GROUP BY rule_id` statement
 * with the disabled filter in SQL; nothing loads `issues` into memory. The
 * answer is bounded by the rule count (at most 174 finding rules), which is why
 * ordering the aggregate in code is not an unbounded structure.
 *
 * `urls` is the number of DISTINCT URLs, as `issue_urls` lists them: the
 * distinct `details.pageUrl` (the key `issue_urls` pages on), with every finding
 * that names no URL standing for one site-wide entry (the `''` bucket, counted
 * as 1). A site-wide rule that carries many URLs (`sitemap.uncrawled`) therefore
 * counts them all, and a rule whose only finding names no URL still reads 1.
 * `issues_list.count` counts FINDINGS and can exceed `urls` when a rule fires
 * more than once per URL (e.g. `social.og-duplicate`).
 */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import type { RuleCategory, Severity, AnyRule, IssueType, Priority } from "../rules/registry/types.js";
import { RULESET_VERSION, type Registry } from "../rules/registry/registry.js";
import { copyRenderer, notDisabled, type JudgementStale, type JudgementView } from "./judgement-view.js";
import { ServiceError } from "./errors.js";

export interface IssuesOverviewRow {
  ruleId: string;
  title: string;
  type: IssueType;
  typeOverridden?: true;
  priority: Priority;
  priorityOverridden?: true;
  severity: Severity;
  category: RuleCategory;
  checkIds: string[];
  /** Distinct URLs, as `issue_urls` lists them (site-wide entry counts 1). */
  urls: number;
  percentOfJudged: number | null;
  marker?: true;
}

export interface IssuesOverview {
  crawlId: string;
  rulesetVersion: string;
  pagesJudged: number | null;
  rows: IssuesOverviewRow[];
  disabledRules: string[];
  judgementStale: JudgementStale;
}

const TYPE_ORDER: Record<IssueType, number> = { issue: 0, warning: 1, opportunity: 2 };
const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/**
 * `site.health`'s Pages Judged (`urlsTotal`), as the rules run stored it.
 * Null when the crawl has no `site.health` row; a row whose value is not an
 * object with a non-negative integer `urlsTotal` throws, naming the crawl — a
 * malformed measurement is never read as "no measurement".
 */
async function storedPagesJudged(db: Db, crawlId: string): Promise<number | null> {
  const result = await db.execute<{ value: unknown }>(sql`
    select m.value_jsonb as value
      from metrics m
     where m.crawl_id = ${crawlId} and m.metric_id = 'site.health' and m.scope = 'site'
     order by m.scope_value asc
     limit 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  const value = row.value;
  const total =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).urlsTotal
      : undefined;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new Error(
      `crawl ${crawlId}'s stored site.health metric has no usable urlsTotal ` +
        `(${JSON.stringify(total)}): re-run the rules over this crawl`,
    );
  }
  return total;
}

/**
 * Build the overview. `ruleFor` is the service's read-time copy join: it throws
 * the 409 `issues_list` raises for a stored finding of a rule the registry lacks.
 */
export async function buildIssuesOverview(
  db: Db,
  crawlId: string,
  registry: Registry,
  view: JudgementView,
  ruleFor: (ruleId: string) => AnyRule,
  includeZero: boolean,
): Promise<IssuesOverview> {
  if (view.judgedWith === null) {
    throw new ServiceError(
      "CONFLICT",
      `crawl ${crawlId} has not been judged: run crawl_rules first — an empty overview ` +
        "would read as a clean site",
    );
  }
  const pagesJudged = await storedPagesJudged(db, crawlId);
  const copy = copyRenderer(view.copyThresholds);

  const result = await db.execute<{ rule_id: string; urls: number }>(sql`
    select i.rule_id,
           count(distinct coalesce(i.details_jsonb->>'pageUrl', ''))::int as urls
      from issues i
     where i.crawl_id = ${crawlId} and ${notDisabled(view.disabledRules)}
     group by i.rule_id`);

  const counts = new Map<string, number>();
  for (const r of result.rows) {
    counts.set(r.rule_id, r.urls);
  }

  const rowFor = (ruleId: string, urls: number): IssuesOverviewRow => {
    const rule = ruleFor(ruleId);
    if (rule.kind === "metric") {
      throw new Error(`issues overview of crawl ${crawlId}: '${ruleId}' is a metric rule`);
    }
    const t = view.typeOf(ruleId);
    const p = view.priorityOf(ruleId);
    return {
      ruleId,
      title: copy(ruleId).title,
      type: t.type,
      ...(t.overridden ? { typeOverridden: true as const } : {}),
      priority: p.priority,
      ...(p.overridden ? { priorityOverridden: true as const } : {}),
      severity: rule.severity,
      category: rule.category,
      checkIds: [...rule.checkIds],
      urls,
      percentOfJudged:
        pagesJudged === null || pagesJudged === 0
          ? null
          : Math.round((urls / pagesJudged) * 1000) / 10,
      ...(rule.marker !== undefined ? { marker: true as const } : {}),
    };
  };

  const rows: IssuesOverviewRow[] = [];
  for (const [ruleId, urls] of counts) rows.push(rowFor(ruleId, urls));
  if (includeZero) {
    for (const rule of registry.all()) {
      if (rule.kind === "metric" || counts.has(rule.id)) continue;
      if (view.disabledRules.includes(rule.id)) continue;
      rows.push(rowFor(rule.id, 0));
    }
  }
  rows.sort(
    (a, b) =>
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      b.urls - a.urls ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  );

  return {
    crawlId,
    rulesetVersion: RULESET_VERSION,
    pagesJudged,
    rows,
    disabledRules: view.disabledRules,
    judgementStale: view.judgementStale,
  };
}

/**
 * A crawl's judgement as the READ surfaces apply it (Phase 27a T5).
 *
 * `runRules` executes and stores every rule, disabled ones included, so what a
 * reader sees is decided here, at read time, from one `select` of the crawl
 * row: which rules are disabled (their findings are left out of every listing,
 * CSV view and export, IN SQL — hard rule 3), what type and priority each rule
 * reads as after the crawl's overrides, which thresholds the copy is rendered
 * with, and whether the stored judgement is stale against the crawl's current
 * block.
 *
 * TWO CLOCKS, ON PURPOSE. Rule overrides (disable / retype / reprioritise) act
 * on what is READ, so the current block applies the moment it is stored.
 * Thresholds change what a run PRODUCES, so the copy that quotes them is
 * rendered from the thresholds the stored findings were judged with — the run's
 * stamp — and a block that has moved since is reported as stale rather than
 * shown as if it had been applied. On a crawl no rules run has judged there
 * are no findings for copy to disagree with, so the copy renders from the
 * current block: it describes the run that is about to happen.
 *
 * Hard rule 7 throughout: a stored block that does not parse throws the
 * `JudgementError` `readStoredJudgement` raised, naming the crawl; a judged
 * crawl with no stamp throws (`readStamp`). Neither is ever read as "no
 * overrides".
 */
import { eq, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { crawls } from "../db/schema.js";
import {
  JudgementError,
  effectiveThresholds,
  judgedWithOf,
  readStamp,
  readStoredJudgement,
  staleReasons,
  type JudgedWith,
  type JudgementBlock,
  type StaleReason,
  type Thresholds,
} from "../rules/judgement.js";
import { storedFindingCap } from "../rules/query/crawl-evidence.js";
import { renderCopy, type IssueCopy } from "../rules/registry/copy/index.js";
import { RULESET_VERSION, type Registry } from "../rules/registry/registry.js";
import type { AnyRule, IssueType, Priority } from "../rules/registry/types.js";
import { ServiceError, clip } from "./errors.js";

/**
 * Whether the crawl's stored judgement no longer matches what its last rules
 * run was judged with, and why (`staleReasons`). `stale` is `false` with no
 * reasons on a crawl no rules run has judged: there is no judgement to be
 * stale.
 */
export interface JudgementStale {
  stale: boolean;
  reasons: StaleReason[];
}

export interface JudgementView {
  /** The crawl's current block, parsed; null is "no overrides". */
  block: JudgementBlock | null;
  /** The rules the CURRENT block disables, sorted ascending. */
  disabledRules: string[];
  /**
   * A finding rule's type after the crawl's overrides. `overridden` is true when
   * the block sets the type — whether or not it matches the rule's default.
   * Throws on a metric rule (it has no type) and on an id the registry lacks.
   */
  typeOf(ruleId: string): { type: IssueType; overridden: boolean };
  /** `typeOf`'s twin for priority, on the same terms. */
  priorityOf(ruleId: string): { priority: Priority; overridden: boolean };
  /**
   * The thresholds client-facing copy is rendered with: the stamp's overrides
   * over the defaults on a judged crawl, the current block's on an unjudged one.
   */
  copyThresholds: Thresholds;
  judgementStale: JudgementStale;
  /** What the last rules run was judged with (the stamp), or null when unjudged. */
  judgedWith: JudgedWith | null;
  /**
   * `config_jsonb.findingCap` as stored: absent (`undefined`, the engine
   * default), `null` (uncapped) or a positive integer. The block's own
   * `findingCap` lives here and nowhere else (plan Deviation 1).
   */
  findingCap: number | null | undefined;
}

/** The columns of a `crawls` row a judgement view is built from. */
export interface JudgementRow {
  config: unknown;
  judgement: unknown;
  rulesJudgedWith: unknown;
  rulesRunAt: Date | null;
}

/**
 * Load a crawl's judgement as the read surfaces apply it, from ONE select of
 * the crawl row (`config`, `judgement`, `rules_judged_with`, `rules_run_at`).
 *
 * Refusals:
 *  - no such crawl: `NOT_FOUND`, as every query route answers one;
 *  - a stored override naming a rule this registry lacks (a rule a later
 *    ruleset removed): `CONFLICT` naming the crawl and the rule, the way a
 *    stored finding of a removed rule is (`ruleFor` in service.ts);
 *  - a stored `config.findingCap` that is not a cap: `CONFLICT`, as
 *    `configFindingCap` answers the same row;
 *  - any other malformed block, or a judged crawl with no or a malformed stamp:
 *    the loud error the rules layer threw, which a transport turns into a 500.
 *
 * `db` is the pool or a transaction: a surface whose answer must come out of
 * one snapshot (the two overviews) reads the view INSIDE it, so the judged
 * marker and the rows it vouches for cannot describe two different moments.
 */
export async function loadJudgementView(
  db: Pick<Db, "select">,
  crawlId: string,
  registry: Registry,
): Promise<JudgementView> {
  const rows = await db
    .select({
      config: crawls.config,
      judgement: crawls.judgement,
      rulesJudgedWith: crawls.rulesJudgedWith,
      rulesRunAt: crawls.rulesRunAt,
    })
    .from(crawls)
    .where(eq(crawls.id, crawlId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new ServiceError("NOT_FOUND", `no such crawl '${clip(crawlId)}'`);
  return judgementViewOf(row, crawlId, registry);
}

/**
 * `loadJudgementView` over a crawl row the caller already holds — for a
 * surface whose answer must come out of ONE read of the row (`crawl_status`,
 * whose `rulesRunAt` and `judgementStale` describe the same instant, and
 * `crawl_compare`, which reads both sides inside its snapshot). Same refusals.
 */
export function judgementViewOf(
  row: JudgementRow,
  crawlId: string,
  registry: Registry,
): JudgementView {
  let block: JudgementBlock | null;
  try {
    block = readStoredJudgement(row.judgement, crawlId, registry);
  } catch (error) {
    if (error instanceof JudgementError && error.reason === "unknown-rule") {
      const ruleId = error.path.startsWith("rules.")
        ? error.path.slice("rules.".length)
        : error.path;
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId}'s stored judgement overrides rule '${clip(ruleId)}', which ruleset ` +
          `${RULESET_VERSION} does not define, so its overrides cannot be applied: remove the ` +
          "override with crawl_config_set",
      );
    }
    throw error;
  }

  const rules = new Map(registry.all().map((rule) => [rule.id, rule]));
  const findingRule = (ruleId: string): Exclude<AnyRule, { kind: "metric" }> => {
    const rule = rules.get(ruleId);
    if (rule === undefined) {
      throw new Error(`judgement view of crawl ${crawlId}: no rule '${ruleId}' in ruleset`);
    }
    if (rule.kind === "metric") {
      throw new Error(
        `judgement view of crawl ${crawlId}: '${ruleId}' is a metric rule, which has no type ` +
          "or priority",
      );
    }
    return rule;
  };
  const overrides = block?.rules ?? {};

  let cap: number | null | undefined;
  try {
    cap = storedFindingCap(row.config, crawlId);
  } catch (error) {
    throw new ServiceError("CONFLICT", error instanceof Error ? error.message : String(error));
  }

  let judgementStale: JudgementStale = { stale: false, reasons: [] };
  let copyThresholds = effectiveThresholds(block);
  let judgedWith: JudgedWith | null = null;
  if (row.rulesRunAt !== null) {
    const stamp = readStamp(row.rulesJudgedWith, crawlId);
    const reasons = staleReasons(judgedWithOf(block, cap), stamp);
    judgementStale = { stale: reasons.length > 0, reasons };
    copyThresholds = effectiveThresholds({ thresholds: stamp.thresholds });
    judgedWith = stamp;
  }

  return {
    block,
    disabledRules: judgedWithOf(block, undefined).disabledRules,
    typeOf(ruleId) {
      const rule = findingRule(ruleId);
      const set = overrides[ruleId]?.type;
      return set === undefined
        ? { type: rule.type, overridden: false }
        : { type: set, overridden: true };
    },
    priorityOf(ruleId) {
      const rule = findingRule(ruleId);
      const set = overrides[ruleId]?.priority;
      return set === undefined
        ? { priority: rule.priority, overridden: false }
        : { priority: set, overridden: true };
    },
    copyThresholds,
    judgementStale,
    judgedWith,
    findingCap: cap,
  };
}

/**
 * The SQL that leaves a disabled rule's stored findings out of a read over
 * `issues i`. `= any(…::text[])` with a BOUND array: drizzle spreads a bare
 * array in a template into a parenthesised parameter list, and the empty set
 * binds as `{}`, which leaves every row in (`site.health`'s spelling, T3).
 */
export function notDisabled(disabledRules: readonly string[]): SQL {
  return sql`not (i.rule_id = any(${sql.param([...disabledRules])}::text[]))`;
}

/**
 * The refusal a rule-scoped listing gives a disabled rule. An empty listing
 * would read as "this rule found nothing", which is not what happened.
 */
export function refuseIfDisabled(view: JudgementView, crawlId: string, ruleId: string): void {
  if (view.disabledRules.includes(ruleId)) {
    throw new ServiceError(
      "CONFLICT",
      `rule '${ruleId}' is disabled on crawl '${crawlId}'; re-enable it with crawl_config_set ` +
        "to list its findings",
    );
  }
}

/**
 * A rule's copy rendered with the view's `copyThresholds`, memoised per id so a
 * streamed export renders each rule once rather than once per row.
 */
export function copyRenderer(thresholds: Thresholds): (ruleId: string) => IssueCopy {
  const rendered = new Map<string, IssueCopy>();
  return (ruleId) => {
    let copy = rendered.get(ruleId);
    if (copy === undefined) {
      copy = renderCopy(ruleId, thresholds);
      rendered.set(ruleId, copy);
    }
    return copy;
  };
}

/**
 * The type and priority fields a finding row carries on the wire: both values,
 * and each `…Overridden` flag only when it is true.
 */
export function triageFields(
  view: JudgementView,
  ruleId: string,
): {
  type: IssueType;
  priority: Priority;
  typeOverridden?: true;
  priorityOverridden?: true;
} {
  const t = view.typeOf(ruleId);
  const p = view.priorityOf(ruleId);
  return {
    type: t.type,
    priority: p.priority,
    ...(t.overridden ? { typeOverridden: true as const } : {}),
    ...(p.overridden ? { priorityOverridden: true as const } : {}),
  };
}

/** A JSON object — not null, not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * RFC 7396 JSON Merge Patch: apply `patch` to `target` and return the result.
 *
 *  - an object patch merges key by key, recursively;
 *  - a `null` value deletes the key (deleting a key that is not there is not
 *    an error);
 *  - anything that is not an object — an array, a string, a number — replaces
 *    the target outright. Arrays are never merged element by element; the
 *    judgement block allows none, so a patch that sends one is replaced in and
 *    refused by `parseJudgement` afterwards.
 *
 * Pure: neither input is mutated. Validation is NOT this function's job; the
 * caller parses the merged document.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

/**
 * A parsed block with its empty sections dropped: `{rules: {}}` — what a
 * merge-patch that removes a crawl's last override leaves — is stored as `{}`,
 * so "no overrides" has one spelling. `findingCap` is NOT carried: its bytes
 * live in `config_jsonb.findingCap` (plan Deviation 1), and the caller writes
 * them there.
 */
export function storableBlock(block: JudgementBlock): JudgementBlock {
  const out: JudgementBlock = {};
  if (block.rules !== undefined && Object.keys(block.rules).length > 0) out.rules = block.rules;
  if (block.thresholds !== undefined && Object.keys(block.thresholds).length > 0) {
    out.thresholds = block.thresholds;
  }
  return out;
}

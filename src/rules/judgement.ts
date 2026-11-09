/**
 * The per-crawl judgement block (Phase 27a): what an agent may change about how
 * one crawl is judged, and the stamp a rules run leaves of what it used.
 *
 * Two kinds of input, applied at two different times:
 *
 *  - RULE OVERRIDES (`rules`): disable, retype or reprioritise a finding rule.
 *    They apply at READ time — a rules run executes and stores every rule,
 *    disabled ones included — so changing one needs no re-run.
 *  - THRESHOLD OVERRIDES (`thresholds`) and the finding cap: they change what a
 *    run produces, so they apply at the NEXT run, which stamps the values it
 *    used (`crawls.rules_judged_with_jsonb`). A stamp that differs from the
 *    crawl's current block is a stale judgement, and `staleReasons` says why.
 *
 * Severity is never overridable: it is the engine's fact about a rule. Metric
 * rules have no type or priority and cannot be disabled.
 *
 * WHERE IT IS STORED. `crawls.judgement_jsonb` holds `rules` and `thresholds`.
 * `findingCap` is part of the block's shape (the API reads and writes it there)
 * but its bytes stay in `crawls.config_jsonb.findingCap`, where `runRules` has
 * always read them (plan Deviation 1), so a stored block that carries its own
 * `findingCap` is refused rather than having one of the two silently win.
 *
 * Hard rule 7 throughout: a stored block that does not parse throws naming the
 * crawl, and is never read as "no overrides"; a judged crawl with no stamp
 * throws rather than being read as "judged with the defaults".
 */
import { z } from "zod";

import { resolveRuleCaps } from "./query/crawl-evidence.js";
import type { Registry } from "./registry/registry.js";
import type { IssueType, Priority } from "./registry/types.js";
import {
  DEFAULT_THRESHOLDS,
  OVERRIDABLE_THRESHOLDS,
  THRESHOLD_NAMES,
  THRESHOLD_ROWS,
  type ThresholdName,
  type ThresholdRow,
  type Thresholds,
} from "./threshold-table.js";

export { DEFAULT_THRESHOLDS, OVERRIDABLE_THRESHOLDS };
export type { ThresholdName, Thresholds };

/**
 * Pairs whose minimum must sit strictly below their maximum, checked on the
 * EFFECTIVE values (default merged with override), so moving one side past the
 * other's default is refused as surely as moving both.
 */
export const THRESHOLD_PAIRS: readonly (readonly [ThresholdName, ThresholdName])[] = [
  ["TITLE_MIN", "TITLE_MAX"],
  ["META_MIN", "META_MAX"],
  ["TITLE_PX_MIN", "TITLE_PX_MAX"],
  ["META_PX_MIN", "META_PX_MAX"],
];

/** One rule's override. Absence of `disabled` means enabled; there is no `false`. */
export interface RuleOverride {
  disabled?: true;
  type?: IssueType;
  priority?: Priority;
}

export interface JudgementBlock {
  rules?: Readonly<Record<string, RuleOverride>>;
  thresholds?: Readonly<Partial<Record<ThresholdName, number>>>;
  /** Positive integer, or null for uncapped. Stored in `config_jsonb.findingCap`. */
  findingCap?: number | null;
}

/**
 * Why a block was refused.
 *  - `unknown-rule`: it names a rule id the registry does not have — on a stored
 *    block, a rule a later ruleset removed (the API maps this to CONFLICT, as it
 *    does a stored finding of a removed rule);
 *  - `invalid`: anything else about the block's shape or values (VALIDATION).
 */
export type JudgementErrorReason = "unknown-rule" | "invalid";

/** A refused judgement block, naming the offending dotted path. */
export class JudgementError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly reason: JudgementErrorReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JudgementError";
  }
}

/**
 * The sentences a refused block's detail is written in. Exported because the
 * published config schema (src/api/config-schema.ts) refuses the same shapes
 * before this parser runs, and must refuse them in the same words — one
 * wording, not two that drift.
 */
export const JUDGEMENT_DETAIL = {
  disabledNotTrue: "only true is accepted; an enabled rule is one with no `disabled` key",
  severity:
    "severity cannot be overridden: it is the engine's fact about the rule; " +
    "change its priority or disable it instead",
  unknownKey: "unknown key",
  notOverridableThreshold: `not an overridable threshold (overridable: ${THRESHOLD_NAMES.join(", ")})`,
  unknownRule: (id: string): string => `no rule '${id}' in ruleset`,
  metricRule: (id: string): string =>
    `'${id}' is a metric rule; it produces no findings, so it cannot be ` +
    "disabled, retyped or reprioritised",
  /** A threshold that is not a number, not an integer, or outside its range. */
  thresholdRange: (min: number, max: number): string => `must be an integer in [${min}, ${max}]`,
  /** A rule override (or a section of the block) that is not an object. */
  notObject: "must be a JSON object",
} as const;

const ruleOverrideSchema = z
  .strictObject(
    {
      disabled: z.literal(true, { error: JUDGEMENT_DETAIL.disabledNotTrue }).optional(),
      type: z.enum(["issue", "warning", "opportunity"]).optional(),
      priority: z.enum(["high", "medium", "low"]).optional(),
    },
    {
      // Only the not-an-object case: unrecognized keys are named by
      // `firstIssue`, which knows their path.
      error: (issue) => (issue.code === "invalid_type" ? JUDGEMENT_DETAIL.notObject : undefined),
    },
  )
  .refine((o) => Object.keys(o).length > 0, {
    message: "an empty override changes nothing; remove the rule's entry instead",
  });

function thresholdValue(row: ThresholdRow) {
  const range = (): string => JUDGEMENT_DETAIL.thresholdRange(row.min, row.max);
  return z
    .number({ error: range })
    .int({ error: range })
    .min(row.min, { error: range })
    .max(row.max, { error: range });
}

const thresholdsSchema = z.strictObject(
  Object.fromEntries(
    THRESHOLD_NAMES.map((n) => [n, thresholdValue(THRESHOLD_ROWS[n]).optional()]),
  ) as Record<ThresholdName, z.ZodOptional<z.ZodNumber>>,
);

const findingCapSchema = z.number().int().min(1).nullable();

const blockSchema = z.strictObject({
  rules: z.record(z.string(), ruleOverrideSchema).optional(),
  thresholds: thresholdsSchema.optional(),
  findingCap: findingCapSchema.optional(),
});

/**
 * A stamp's thresholds: EVERY overridable threshold, each the effective value
 * the run used — required, an integer, within its range. A stamp missing one is
 * malformed (it cannot say what the run judged with), never "the default".
 */
const stampThresholdsSchema = z.strictObject(
  Object.fromEntries(THRESHOLD_NAMES.map((n) => [n, thresholdValue(THRESHOLD_ROWS[n])])) as Record<
    ThresholdName,
    z.ZodNumber
  >,
);

const stampSchema = z.strictObject({
  disabledRules: z.array(z.string()),
  thresholds: stampThresholdsSchema,
  findingCap: findingCapSchema.optional(),
});

/** The first zod issue, as a dotted path and a sentence that names it. */
function firstIssue(error: z.ZodError): { path: string; message: string } {
  const issue = error.issues[0];
  if (issue === undefined) throw new Error("zod reported a failure with no issue");
  const segments = issue.path.map(String);
  let detail = issue.message;
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    if (key === undefined) throw new Error("zod reported unrecognized keys with no key");
    segments.push(key);
    const parent = issue.path.map(String);
    if (key === "severity" && parent[0] === "rules" && parent.length === 2) {
      detail = JUDGEMENT_DETAIL.severity;
    } else if (parent.length === 1 && parent[0] === "thresholds") {
      detail = JUDGEMENT_DETAIL.notOverridableThreshold;
    } else {
      detail = JUDGEMENT_DETAIL.unknownKey;
    }
  }
  const path = segments.join(".");
  return { path, message: `${path === "" ? "(the block)" : path}: ${detail}` };
}

/**
 * Parse a judgement block against the ruleset that will apply it. Strict at
 * every level: unknown keys, `severity`, an unknown or metric rule id, an empty
 * override, `disabled: false`, an out-of-range or non-integer threshold, a
 * crossed pair and a findingCap that is neither a positive integer nor null are
 * all refused, each as a `JudgementError` naming a dotted path.
 */
export function parseJudgement(raw: unknown, registry: Registry): JudgementBlock {
  const parsed = blockSchema.safeParse(raw);
  if (!parsed.success) {
    const { path, message } = firstIssue(parsed.error);
    throw new JudgementError(path, message, "invalid");
  }
  const block = parsed.data as JudgementBlock;

  if (block.rules !== undefined) {
    const kinds = new Map(registry.all().map((r) => [r.id, r.kind]));
    for (const id of Object.keys(block.rules)) {
      const path = `rules.${id}`;
      const kind = kinds.get(id);
      if (kind === undefined) {
        throw new JudgementError(path, `${path}: ${JUDGEMENT_DETAIL.unknownRule(id)}`, "unknown-rule");
      }
      if (kind === "metric") {
        throw new JudgementError(path, `${path}: ${JUDGEMENT_DETAIL.metricRule(id)}`, "invalid");
      }
    }
  }

  if (block.thresholds !== undefined) {
    const given = block.thresholds;
    const eff = effectiveThresholds(block);
    for (const [lo, hi] of THRESHOLD_PAIRS) {
      if (eff[lo] < eff[hi]) continue;
      const path = `thresholds.${given[lo] !== undefined ? lo : hi}`;
      const said = (n: ThresholdName) =>
        `thresholds.${n} (${String(eff[n])}${given[n] === undefined ? ", the default" : ""})`;
      throw new JudgementError(
        path,
        `${path}: ${said(lo)} must be strictly below ${said(hi)}`,
        "invalid",
      );
    }
  }

  return block;
}

/** Every overridable threshold, with the block's overrides over the defaults. */
export function effectiveThresholds(block: JudgementBlock | null): Thresholds {
  return Object.freeze({ ...DEFAULT_THRESHOLDS, ...(block?.thresholds ?? {}) });
}

/**
 * What a rules run was judged with: the stamp in `crawls.rules_judged_with_jsonb`.
 * Retypes and reprioritisations are not in it — they change nothing stored.
 */
export interface JudgedWith {
  /** Sorted ascending. */
  disabledRules: string[];
  /**
   * All 20 overridable thresholds, each the EFFECTIVE value the run used (its
   * override, else the ruleset's default at the time). Stored whole rather than
   * as overrides so the stamp stays true when a later ruleset moves a default:
   * the copy is rendered from these values and staleness is measured against
   * them, never against today's defaults (migration 0033 rewrote older stamps).
   */
  thresholds: Record<ThresholdName, number>;
  /** Absent when the engine's default cap applied; null is uncapped. */
  findingCap?: number | null;
}

/**
 * The stamp for a run under `block` with the cap the run took as input — the
 * caller's, else the crawl's `config.findingCap`, else `undefined` (the engine
 * default, recorded by the key's absence).
 */
export function judgedWithOf(
  block: JudgementBlock | null,
  findingCap: number | null | undefined,
): JudgedWith {
  const disabledRules = Object.entries(block?.rules ?? {})
    .filter(([, o]) => o.disabled === true)
    .map(([id]) => id)
    .sort();
  const stamp: JudgedWith = { disabledRules, thresholds: { ...effectiveThresholds(block) } };
  if (findingCap !== undefined) stamp.findingCap = findingCap;
  return stamp;
}

export type StaleReason = "overrides" | "thresholds" | "findingCap";

/**
 * Why a judgement stamped as `stamped` is stale against the crawl's `current`
 * block, sorted; empty when it is not.
 *
 * Compared on what a run would DO, not on how the inputs were spelled: both
 * sides carry effective thresholds, so an override naming a threshold's default
 * is the default — and a later ruleset that moves a default reads stale
 * `thresholds` against a stamp of the old value, as it must; naming the
 * engine's default cap is the same budget as omitting it (`resolveRuleCaps`).
 * The disabled sets are compared as sets.
 */
export function staleReasons(current: JudgedWith, stamped: JudgedWith): StaleReason[] {
  const reasons: StaleReason[] = [];
  if (
    resolveRuleCaps(current.findingCap).listing !== resolveRuleCaps(stamped.findingCap).listing
  ) {
    reasons.push("findingCap");
  }
  const a = [...current.disabledRules].sort();
  const b = [...stamped.disabledRules].sort();
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) reasons.push("overrides");
  if (THRESHOLD_NAMES.some((n) => current.thresholds[n] !== stamped.thresholds[n])) {
    reasons.push("thresholds");
  }
  return reasons;
}

/**
 * A crawl's stored block (`crawls.judgement_jsonb`). Null is "no overrides";
 * anything else is parsed, and a refusal is re-thrown naming the crawl with its
 * reason and path kept. A stored `findingCap` is refused: the cap's bytes live
 * in `config_jsonb.findingCap` (see the module header).
 */
export function readStoredJudgement(
  raw: unknown,
  crawlId: string,
  registry: Registry,
): JudgementBlock | null {
  if (raw === null) return null;
  let block: JudgementBlock;
  try {
    block = parseJudgement(raw, registry);
  } catch (error) {
    if (!(error instanceof JudgementError)) throw error;
    throw new JudgementError(
      error.path,
      `crawl ${crawlId}: stored judgement block is refused: ${error.message}`,
      error.reason,
      { cause: error },
    );
  }
  if (block.findingCap !== undefined) {
    throw new JudgementError(
      "findingCap",
      `crawl ${crawlId}: stored judgement block carries findingCap, which is stored in ` +
        "config_jsonb.findingCap and nowhere else",
      "invalid",
    );
  }
  return block;
}

/**
 * A crawl's stamp (`crawls.rules_judged_with_jsonb`), validated. Callers read it
 * only when `rules_run_at` is not null, so a null here is a judged crawl with no
 * record of what it was judged with — thrown, naming the crawl. So is a stamp
 * whose `thresholds` lack any of the 20 names, or hold a non-integer or
 * out-of-range value: it cannot say what the run used (hard rule 7).
 */
export function readStamp(raw: unknown, crawlId: string): JudgedWith {
  if (raw === null || raw === undefined) {
    throw new Error(
      `crawl ${crawlId}: judged (rules_run_at is set) but rules_judged_with_jsonb is missing`,
    );
  }
  const parsed = stampSchema.safeParse(raw);
  if (!parsed.success) {
    const { message } = firstIssue(parsed.error);
    throw new Error(`crawl ${crawlId}: stored rules_judged_with_jsonb is malformed at ${message}`);
  }
  return parsed.data as JudgedWith;
}

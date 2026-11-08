/**
 * The overridable thresholds and their defaults, in a module with no runtime
 * dependency on the rule registry.
 *
 * It exists apart from judgement.ts because `registry/types.ts` needs
 * `DEFAULT_THRESHOLDS` at runtime (for `DEFAULT_JUDGEMENT`), and judgement.ts
 * imports the query helpers, which import the registry, which imports types:
 * putting the table here keeps that chain from becoming a cycle. judgement.ts
 * re-exports everything below, so it stays the one place callers import from.
 */
import {
  CHAIN_HOPS,
  DEEP_DEPTH,
  H1_MAX,
  H2_MAX,
  HIGH_EXTERNAL_OUTLINKS,
  HIGH_INTERNAL_OUTLINKS,
  IMAGE_WEIGHT_WARN,
  META_MAX,
  META_MIN,
  META_PX_MAX,
  META_PX_MIN,
  SLOW_MS,
  SOFT_404_WORDS,
  THIN_WORDS,
  TITLE_MAX,
  TITLE_MIN,
  TITLE_PX_MAX,
  TITLE_PX_MIN,
  UNAVAILABLE_AFTER_WARN_DAYS,
  URL_MAX,
} from "./thresholds.js";

export interface ThresholdRow {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export const THRESHOLD_ROWS = {
  TITLE_MIN: { min: 1, max: 200, default: TITLE_MIN },
  TITLE_MAX: { min: 1, max: 300, default: TITLE_MAX },
  META_MIN: { min: 1, max: 300, default: META_MIN },
  META_MAX: { min: 1, max: 500, default: META_MAX },
  H1_MAX: { min: 1, max: 300, default: H1_MAX },
  H2_MAX: { min: 1, max: 300, default: H2_MAX },
  URL_MAX: { min: 20, max: 2500, default: URL_MAX },
  SLOW_MS: { min: 100, max: 60000, default: SLOW_MS },
  TITLE_PX_MIN: { min: 1, max: 2000, default: TITLE_PX_MIN },
  TITLE_PX_MAX: { min: 1, max: 2000, default: TITLE_PX_MAX },
  META_PX_MIN: { min: 1, max: 4000, default: META_PX_MIN },
  META_PX_MAX: { min: 1, max: 4000, default: META_PX_MAX },
  DEEP_DEPTH: { min: 1, max: 100, default: DEEP_DEPTH },
  THIN_WORDS: { min: 1, max: 10000, default: THIN_WORDS },
  SOFT_404_WORDS: { min: 1, max: 10000, default: SOFT_404_WORDS },
  IMAGE_WEIGHT_WARN: { min: 1000, max: 100_000_000, default: IMAGE_WEIGHT_WARN },
  // The range keeps it below MAX_REDIRECT_HOPS (10): a chain is reported from
  // CHAIN_HOPS, and the walk stops at MAX_REDIRECT_HOPS.
  CHAIN_HOPS: { min: 1, max: 9, default: CHAIN_HOPS },
  HIGH_INTERNAL_OUTLINKS: { min: 1, max: 100_000, default: HIGH_INTERNAL_OUTLINKS },
  HIGH_EXTERNAL_OUTLINKS: { min: 1, max: 100_000, default: HIGH_EXTERNAL_OUTLINKS },
  UNAVAILABLE_AFTER_WARN_DAYS: { min: 0, max: 3650, default: UNAVAILABLE_AFTER_WARN_DAYS },
} as const satisfies Record<string, ThresholdRow>;

/** A threshold an agent may override on a crawl. */
export type ThresholdName = keyof typeof THRESHOLD_ROWS;
/** One value for every overridable threshold. */
export type Thresholds = Readonly<Record<ThresholdName, number>>;

/**
 * The overridable thresholds: an inclusive integer range each, and the default
 * imported from src/rules/thresholds.ts (never restated here). Everything else
 * in that module — extraction-time limits, similarity distances, render
 * heuristics, walk bounds, protocol limits, word lists — is an engine internal
 * or a protocol fact, not a site preference, and is not on this list.
 */
export const OVERRIDABLE_THRESHOLDS: Readonly<Record<ThresholdName, ThresholdRow>> = Object.freeze(
  THRESHOLD_ROWS,
);

export const THRESHOLD_NAMES = Object.keys(THRESHOLD_ROWS) as ThresholdName[];

/** The thresholds a crawl with no overrides is judged with. */
export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze(
  Object.fromEntries(THRESHOLD_NAMES.map((n) => [n, THRESHOLD_ROWS[n].default])) as Record<
    ThresholdName,
    number
  >,
);

/**
 * Crawl lifecycle control vocabulary (Phase 27b).
 *
 * `crawls.control_request` and `crawls.pause_reason` are free text, no DB
 * constraint, so these readers are the constraint: a value this engine did not
 * write is a defect of ours and throws naming the crawl (rule 7).
 */

export const CONTROL_REQUESTS = ["pause", "cancel"] as const;
export type ControlRequest = (typeof CONTROL_REQUESTS)[number];

export const PAUSE_REASONS = ["request", "shutdown"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

function readOf<T extends string>(
  column: string,
  allowed: readonly T[],
  value: unknown,
  crawlId: string,
): T | null {
  if (value === null) return null;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `crawl '${crawlId}' has ${column} ${JSON.stringify(value)}, which this engine never writes (expected null or one of ${allowed.join(", ")})`,
  );
}

export function readControlRequest(value: unknown, crawlId: string): ControlRequest | null {
  return readOf("control_request", CONTROL_REQUESTS, value, crawlId);
}

export function readPauseReason(value: unknown, crawlId: string): PauseReason | null {
  return readOf("pause_reason", PAUSE_REASONS, value, crawlId);
}

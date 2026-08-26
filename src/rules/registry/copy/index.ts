import { ISSUE_COPY, type IssueCopy } from "./issue-copy.js";

export { ISSUE_COPY, type IssueCopy };

/**
 * The client-facing text for a rule. Throws on a miss: every rule spreads its
 * copy at module load, so a missing entry is a load-time failure that names the
 * rule, never a rule that ships with empty text.
 */
export function copyFor(ruleId: string): IssueCopy {
  const c = ISSUE_COPY[ruleId];
  if (!c) throw new Error(`no copy for rule '${ruleId}' — add it to issue-copy.ts`);
  return c;
}

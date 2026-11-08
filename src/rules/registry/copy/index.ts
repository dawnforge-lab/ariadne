import { DEFAULT_THRESHOLDS, OVERRIDABLE_THRESHOLDS, type Thresholds } from "../../threshold-table.js";
import { COPY_TEMPLATES, type IssueCopy } from "./issue-copy.js";

export { COPY_TEMPLATES, type IssueCopy };

const FIELDS = ["title", "explanation", "howToFix"] as const;

/**
 * Substitute `{NAME}` (String(value)) and `{NAME:n}` (en-US thousands
 * separators) in one string. A placeholder naming no overridable threshold, or
 * a `{...}` still in the text afterwards, throws: copy that ships a raw
 * placeholder to a client is a defect, never rendered as-is.
 */
function render(ruleId: string, field: string, text: string, thresholds: Thresholds): string {
  const out = text.replace(/\{([A-Z0-9_]+)(:n)?\}/g, (whole, name: string, grouped?: string) => {
    if (!Object.hasOwn(OVERRIDABLE_THRESHOLDS, name)) {
      throw new Error(`copy for rule '${ruleId}' (${field}): unknown threshold placeholder ${whole}`);
    }
    const value = thresholds[name as keyof Thresholds];
    return grouped ? value.toLocaleString("en-US") : String(value);
  });
  const left = /\{[^}]*\}/.exec(out);
  if (left) {
    throw new Error(`copy for rule '${ruleId}' (${field}): unresolved placeholder ${left[0]}`);
  }
  return out;
}

/**
 * The client-facing text for a rule, rendered from the thresholds a crawl was
 * judged with, so an override shows up in the copy. Throws on a miss: every
 * rule spreads its copy at module load, so a missing entry is a load-time
 * failure that names the rule, never a rule that ships with empty text.
 */
export function renderCopy(ruleId: string, thresholds: Thresholds): IssueCopy {
  const t = COPY_TEMPLATES[ruleId];
  if (!t) throw new Error(`no copy for rule '${ruleId}' — add it to issue-copy.ts`);
  const [title, explanation, howToFix] = FIELDS.map((f) => render(ruleId, f, t[f], thresholds));
  return { title: title!, explanation: explanation!, howToFix: howToFix! };
}

/** Every entry rendered at the default thresholds (the text a crawl with no overrides shows). */
export const ISSUE_COPY: Record<string, IssueCopy> = Object.freeze(
  Object.fromEntries(
    Object.keys(COPY_TEMPLATES).map((id) => [id, renderCopy(id, DEFAULT_THRESHOLDS)]),
  ),
);

export function copyFor(ruleId: string): IssueCopy {
  return renderCopy(ruleId, DEFAULT_THRESHOLDS);
}

import { finding, isJudged, pageRule, present } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";
import { serpWidth } from "../serp-width.js";
import type { ThresholdName } from "../threshold-table.js";

/**
 * Title and meta description width in pixels (Phase 26a, CHECK-35 and
 * CHECK-36). Search results are cut by width, not by character count, so these
 * sit beside `title.too-long` and `meta-description.too-long` rather than
 * replacing them.
 *
 * THE GATE is `isJudged`, a present value, and a measurable value: `serpWidth`
 * returns null when any character is outside the table we measured (CJK, emoji,
 * most symbols). Such a value is NOT pixel-judged, by deviation 6 of the plan:
 * the copy says so, and the character-count rules still apply to it. There is
 * no assumed width for a character we have not measured.
 */
const CATEGORY = "on-page";

type Field = "title" | "metaDescription";

/** The value and its width, or null when the page is not to be pixel-judged. */
function measured(p: PageRecord, field: Field): { text: string; width: number } | null {
  const text = p[field];
  if (!isJudged(p) || !present(text)) return null;
  const width = serpWidth(text, field === "title" ? "title" : "description");
  return width === null ? null : { text, width };
}

function pixelRule(
  id: string,
  check: string,
  severity: "warning" | "info",
  field: Field,
  side: "over" | "under",
  // The overridable threshold that bounds it, read from the run context: a
  // bound captured here would be one value for every crawl in the process.
  bound: ThresholdName,
): PageRule {
  const label = field === "title" ? "Title 1" : "Meta Description 1";
  const boundKey = side === "over" ? "max" : "min";
  return pageRule(
    id,
    [check],
    CATEGORY,
    severity,
    [
      { key: field, label },
      { key: "pixelWidth", label: `${label} Pixel Width` },
      { key: boundKey, label: side === "over" ? "Maximum Pixel Width" : "Minimum Pixel Width" },
    ],
    (p, self, j) => {
      const m = measured(p, field);
      const limit = j.thresholds[bound];
      if (m === null) return [];
      const fires = side === "over" ? m.width > limit : m.width < limit;
      return fires
        ? [finding(self, p, { [field]: m.text, pixelWidth: m.width, [boundKey]: limit })]
        : [];
    },
  );
}

export const pixelWidthRules: PageRule[] = [
  pixelRule("title.pixel-too-long", "CHECK-35", "warning", "title", "over", "TITLE_PX_MAX"),
  pixelRule("title.pixel-too-short", "CHECK-35", "info", "title", "under", "TITLE_PX_MIN"),
  pixelRule("meta-description.pixel-too-long", "CHECK-36", "warning", "metaDescription", "over", "META_PX_MAX"),
  pixelRule("meta-description.pixel-too-short", "CHECK-36", "info", "metaDescription", "under", "META_PX_MIN"),
];

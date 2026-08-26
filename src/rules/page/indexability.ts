import { finding, isAuditable, pageRule } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";

const CATEGORY = "indexability";

/** Present means "declares something": a null, empty or blank directive does not. */
function present(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/**
 * `none` as a whole directive: the list is comma- and space-delimited, so the
 * token has to be bounded on both sides. A substring test would read "nonevent"
 * as a directive and hide the page from every rule below.
 */
const NONE_DIRECTIVE = /(?:^|[\s,])none(?:[\s,]|$)/i;

/**
 * Whether a robots directive string asks for noindex. Substring match for
 * `noindex` itself, because the directive arrives as a comma list
 * ("max-snippet:-1, noindex, nofollow") and the value is stored verbatim.
 *
 * `none` counts too: it is Google's shorthand for "noindex, nofollow", and a
 * page carrying it is out of the index just as surely as one that spelled the
 * directive out. Exported so the canonical rules ask the same question rather
 * than growing a second definition of "noindex".
 *
 * MIRRORED IN `isIndexable` (src/crawl/persist.ts), which stamps
 * `pages.is_indexable` at crawl time from the same two robots sources. The two
 * must agree — a page this function calls noindex and that column calls
 * indexable is a contradiction the report cannot resolve. Change one, change
 * the other.
 */
export function saysNoindex(value: string | null): boolean {
  return present(value) && (/noindex/i.test(value) || NONE_DIRECTIVE.test(value));
}

/** Whether either robots source on this page asks for noindex. */
export function hasNoindex(page: PageRecord): boolean {
  return saysNoindex(page.robotsMeta) || saysNoindex(page.xRobotsTag);
}

export const indexabilityRules: PageRule[] = [
  // A fact, not a fault: most sites noindex their thank-you, filter and admin
  // pages on purpose. Severity stays `info` and the agent decides whether this
  // particular URL should have been in the index.
  pageRule("indexability.noindex", ["CHECK-04"], CATEGORY, "info", (p, self) => {
    const meta = saysNoindex(p.robotsMeta);
    const header = saysNoindex(p.xRobotsTag);
    if (!isAuditable(p) || (!meta && !header)) return [];
    const source = meta && header ? "both" : meta ? "meta" : "header";
    return [
      finding(self, p, { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag, source }),
    ];
  }),

  // Both sources declare something and only one of them says noindex. Engines
  // resolve conflicting robots directives by taking the most restrictive, so
  // the page is very likely noindex whichever source was meant to win.
  pageRule("indexability.meta-header-conflict", ["CHECK-04"], CATEGORY, "warning", (p, self) => {
    if (!isAuditable(p) || !present(p.robotsMeta) || !present(p.xRobotsTag)) return [];
    return saysNoindex(p.robotsMeta) !== saysNoindex(p.xRobotsTag)
      ? [finding(self, p, { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag })]
      : [];
  }),
];

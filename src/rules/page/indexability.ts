import { finding, isAuditable, pageRule, present, saysNoindex } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";

const CATEGORY = "indexability";

/**
 * `saysNoindex` and `hasNoindex` MOVED TO src/rules/helpers.ts (Phase 20) and
 * are re-exported here at their old address.
 *
 * They went for `resolveEffectiveCanonical`'s reason: they gained a second
 * class of caller. `indexabilityOf` labels EVERY finding row on the API surface
 * `Indexable` or `Noindex`, and it lives in helpers.ts, which cannot import a
 * rule file that imports helpers.ts. One definition of "noindex", read by the
 * rule that reports it and by the column that labels every other rule's rows —
 * the alternative is two spellings that agree until one of them is edited.
 */
export { hasNoindex, saysNoindex } from "../helpers.js";

export const indexabilityRules: PageRule[] = [
  // A fact, not a fault: most sites noindex their thank-you, filter and admin
  // pages on purpose. Severity stays `info` and the agent decides whether this
  // particular URL should have been in the index.
  pageRule(
    "indexability.noindex",
    ["CHECK-04"],
    CATEGORY,
    "info",
    [
      { key: "robotsMeta", label: "Meta Robots" },
      { key: "xRobotsTag", label: "X-Robots-Tag" },
      { key: "source", label: "Directive Source" },
    ],
    (p, self) => {
      const meta = saysNoindex(p.robotsMeta);
      const header = saysNoindex(p.xRobotsTag);
      if (!isAuditable(p) || (!meta && !header)) return [];
      const source = meta && header ? "both" : meta ? "meta" : "header";
      return [
        finding(self, p, { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag, source }),
      ];
    },
  ),

  // Both sources declare something and only one of them says noindex. Engines
  // resolve conflicting robots directives by taking the most restrictive, so
  // the page is very likely noindex whichever source was meant to win.
  pageRule(
    "indexability.meta-header-conflict",
    ["CHECK-04"],
    CATEGORY,
    "critical",
    [
      { key: "robotsMeta", label: "Meta Robots" },
      { key: "xRobotsTag", label: "X-Robots-Tag" },
    ],
    (p, self) => {
      if (!isAuditable(p) || !present(p.robotsMeta) || !present(p.xRobotsTag)) return [];
      return saysNoindex(p.robotsMeta) !== saysNoindex(p.xRobotsTag)
        ? [finding(self, p, { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag })]
        : [];
    },
  ),
];

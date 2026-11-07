/**
 * The HTML structure page rules (Phase 26b, CHECK-88 and, for the early head
 * close, CHECK-18 / CHECK-04 / CHECK-24). All three read `pages.htmlStructure`, the
 * document shape the streaming analyzer recorded: counts of `<html>`, `<head>`
 * and `<body>` start tags, whether the first head came before the first body,
 * and the element, text or noscript child that ended the head early.
 *
 * `closedEarly` is already the analyzer's verdict: it is set only when the
 * document later shows the head was meant to continue (see the analyzer's head
 * state machine), so a valid document that omits `</head>` is not flagged and
 * these rules do no second guessing. A null `htmlStructure` is a row extraction
 * 2 never wrote; every rule is silent there and `extraction.not-recorded`
 * speaks.
 *
 * Owner call O3 (2026-11-07) splits the early close by `closedEarly.lost`, the
 * head tags after the closer that a parser closing the head there moves into
 * the body: `html.head-closed-early` (warning) when something is lost,
 * `html.head-closed-early-harmless` (info) when nothing is (the tracking-pixel
 * `<noscript><img>` last in the head). `lost` is read through `closedEarlyLost`,
 * which throws on a version-2 row written before it was recorded.
 */
import { finding, isAuditable, pageRule } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";

/**
 * `closedEarly.lost` of a row whose `closedEarly` is non-null. jsonb is not
 * checked against the type: a version-2 row written before owner call O3 has no
 * `lost` key, and reading that as "nothing lost" would turn every early close
 * on it into the harmless note. Loud instead; a re-crawl fixes it (the
 * `social.imageRefs` precedent in src/rules/query/social.ts). Shared with the
 * head rules, which read the same fact.
 */
export function closedEarlyLost(
  ruleId: string,
  p: PageRecord,
  closed: NonNullable<NonNullable<PageRecord["htmlStructure"]>["closedEarly"]>,
): string[] {
  const lost = (closed as { lost?: string[] }).lost;
  if (lost === undefined) {
    throw new Error(
      `${ruleId}: page ${p.url} has an early head close with no lost list ` +
        `(written before it was recorded); re-crawl`,
    );
  }
  return lost;
}

const EARLY_COLUMNS = [
  { key: "tag", label: "Closing Element" },
  { key: "snippet", label: "Element Snippet" },
  { key: "inNoscript", label: "Inside noscript" },
] as const;

/** The structural problems, in a fixed order, as one column value. */
function problems(s: NonNullable<PageRecord["htmlStructure"]>): string[] {
  const out: string[] = [];
  if (s.headTags === 0) out.push("head-missing");
  if (s.headTags > 1) out.push("head-repeated");
  if (s.bodyTags === 0) out.push("body-missing");
  if (s.bodyTags > 1) out.push("body-repeated");
  if (s.headBeforeBody === false) out.push("head-after-body");
  return out;
}

export const htmlStructureRules: PageRule[] = [
  pageRule(
    "html.head-closed-early",
    ["CHECK-18", "CHECK-04", "CHECK-24"],
    "technical",
    "warning",
    [...EARLY_COLUMNS, { key: "lost", label: "Head Tags Lost" }],
    (p, self) => {
      if (!isAuditable(p)) return [];
      const closed = p.htmlStructure?.closedEarly;
      if (closed === null || closed === undefined) return [];
      const lost = closedEarlyLost(self.id, p, closed);
      if (lost.length === 0) return [];
      return [
        finding(self, p, {
          tag: closed.tag,
          snippet: closed.snippet,
          inNoscript: closed.inNoscript,
          lost,
        }),
      ];
    },
  ),

  pageRule(
    "html.head-closed-early-harmless",
    ["CHECK-18", "CHECK-04", "CHECK-24"],
    "technical",
    "info",
    [...EARLY_COLUMNS],
    (p, self) => {
      if (!isAuditable(p)) return [];
      const closed = p.htmlStructure?.closedEarly;
      if (closed === null || closed === undefined) return [];
      if (closedEarlyLost(self.id, p, closed).length > 0) return [];
      return [
        finding(self, p, { tag: closed.tag, snippet: closed.snippet, inNoscript: closed.inNoscript }),
      ];
    },
  ),

  pageRule(
    "html.structure-invalid",
    ["CHECK-88"],
    "technical",
    "info",
    [
      { key: "problems", label: "Problems" },
      { key: "headTags", label: "Head Elements" },
      { key: "bodyTags", label: "Body Elements" },
    ],
    (p, self) => {
      if (!isAuditable(p) || p.htmlStructure === null) return [];
      const found = problems(p.htmlStructure);
      if (found.length === 0) return [];
      return [
        finding(self, p, {
          problems: found,
          headTags: p.htmlStructure.headTags,
          bodyTags: p.htmlStructure.bodyTags,
        }),
      ];
    },
  ),
];

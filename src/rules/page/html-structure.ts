/**
 * The HTML structure page rules (Phase 26b, CHECK-88 and, for the early head
 * close, CHECK-18 / CHECK-04 / CHECK-24). Both read `pages.htmlStructure`, the
 * document shape the streaming analyzer recorded: counts of `<html>`, `<head>`
 * and `<body>` start tags, whether the first head came before the first body,
 * and the element, text or noscript child that ended the head early.
 *
 * `closedEarly` is already the analyzer's verdict: it is set only when the
 * document later shows the head was meant to continue (see the analyzer's head
 * state machine), so a valid document that omits `</head>` is not flagged and
 * these rules do no second guessing. A null `htmlStructure` is a row extraction
 * 2 never wrote; both rules are silent there and `extraction.not-recorded`
 * speaks.
 */
import { finding, isAuditable, pageRule } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";

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
    [
      { key: "tag", label: "Closing Element" },
      { key: "snippet", label: "Element Snippet" },
      { key: "inNoscript", label: "Inside noscript" },
    ],
    (p, self) => {
      if (!isAuditable(p)) return [];
      const closed = p.htmlStructure?.closedEarly;
      if (closed === null || closed === undefined) return [];
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

/**
 * The pagination page rule (Phase 26b, CHECK-22): a page that declares more than
 * one `<link rel=next>` or more than one `<link rel=prev>`. A series has one
 * neighbour each way, so a second declaration means two templates or plugins
 * wrote the same tag and a consumer cannot tell which one is meant.
 *
 * It reads `pages.relNextCount` / `relPrevCount`, counted at extraction over
 * every `<link>` carrying the token, href or not. Both are null on a v1 row, so
 * the rule is silent there and `extraction.not-recorded` speaks. The 26a
 * pagination rules are query rules over the declared targets; this one needs
 * only the page.
 */
import { finding, isAuditable, pageRule } from "../helpers.js";
import type { PageRule } from "../registry/types.js";

export const paginationPageRules: PageRule[] = [
  pageRule(
    "pagination.multiple",
    ["CHECK-22"],
    "url",
    "info",
    [
      { key: "relNextCount", label: "rel=next Links" },
      { key: "relPrevCount", label: "rel=prev Links" },
    ],
    (p, self) => {
      if (!isAuditable(p) || p.relNextCount === null || p.relPrevCount === null) return [];
      if (p.relNextCount <= 1 && p.relPrevCount <= 1) return [];
      return [finding(self, p, { relNextCount: p.relNextCount, relPrevCount: p.relPrevCount })];
    },
  ),
];

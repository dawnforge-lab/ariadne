/**
 * The anchor page rules (Phase 26b, CHECK-34 and CHECK-86): what the `<a>` tags
 * of a page say about whether a crawler can follow them and whether they are
 * safe to open in a new tab. All three read `pages.anchorCounts`, counted over
 * every `<a>` start tag at extraction (including links the link table never
 * stores). A v1 row has a null `anchorCounts` and is silent; the
 * `extraction.not-recorded` marker speaks for it.
 */
import { finding, isAuditable, pageRule } from "../helpers.js";
import type { PageRule } from "../registry/types.js";

export const anchorRules: PageRule[] = [
  pageRule(
    "links.uncrawlable",
    ["CHECK-34"],
    "links",
    "warning",
    [
      { key: "noHref", label: "No href" },
      { key: "javascript", label: "javascript: href" },
      { key: "hashOnly", label: "# href" },
    ],
    (p, self) => {
      if (!isAuditable(p) || p.anchorCounts === null) return [];
      const { noHref, javascript, hashOnly } = p.anchorCounts;
      if (noHref + javascript + hashOnly === 0) return [];
      return [finding(self, p, { noHref, javascript, hashOnly })];
    },
  ),

  pageRule(
    "links.empty-href",
    ["CHECK-86"],
    "links",
    "info",
    [{ key: "emptyHref", label: "Empty href" }],
    (p, self) => {
      if (!isAuditable(p) || p.anchorCounts === null || p.anchorCounts.emptyHref === 0) return [];
      return [finding(self, p, { emptyHref: p.anchorCounts.emptyHref })];
    },
  ),

  pageRule(
    "links.unsafe-target-blank",
    ["CHECK-86"],
    "links",
    "info",
    [{ key: "unsafeBlank", label: "target=_blank without noopener" }],
    (p, self) => {
      if (!isAuditable(p) || p.anchorCounts === null || p.anchorCounts.unsafeBlank === 0) return [];
      return [finding(self, p, { unsafeBlank: p.anchorCounts.unsafeBlank })];
    },
  ),
];

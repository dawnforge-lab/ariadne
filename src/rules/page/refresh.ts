/**
 * The meta refresh page rule (Phase 26b, CHECK-10): a page that sends the
 * browser elsewhere through `<meta http-equiv=refresh>` or the `Refresh`
 * response header. Neither is a 3xx, so link signals and indexing treat the
 * page as a live page, not a redirect.
 *
 * It reads `pages.metaRefresh` (a `RefreshFact`, parsed at extraction) and the
 * stored `refresh` header (`responseHeaders.values.refresh[0]`, parsed here by
 * the same `parseRefresh`). A refresh with no URL (a plain reload timer) is not
 * a redirect and is silent. A row extraction 2 never wrote has a null
 * `metaRefresh` and no header, so it is silent; the marker speaks.
 */
import { parseRefresh } from "../../crawl/parse/page-facts.js";
import { normalizeUrl } from "../../crawl/parse/url-utils.js";
import { finding, isAuditable, pageRule } from "../helpers.js";
import type { PageRule } from "../registry/types.js";

export const refreshRules: PageRule[] = [
  pageRule(
    "redirect.meta-refresh",
    ["CHECK-10"],
    "redirects",
    "warning",
    [
      { key: "source", label: "Refresh Source" },
      { key: "target", label: "Refresh Target" },
      { key: "delaySeconds", label: "Refresh Delay (s)", optional: true },
      { key: "selfTarget", label: "Refreshes To Itself" },
    ],
    (p, self) => {
      if (!isAuditable(p)) return [];
      const meta = p.metaRefresh !== null && p.metaRefresh.target !== null ? p.metaRefresh : null;
      const headerValue = p.responseHeaders?.values["refresh"]?.[0];
      const parsedHeader = headerValue === undefined ? null : parseRefresh(headerValue, p.url);
      const header = parsedHeader !== null && parsedHeader.target !== null ? parsedHeader : null;
      const used = meta ?? header;
      if (used === null || used.target === null) return [];
      const source = meta !== null && header !== null ? "both" : meta !== null ? "meta" : "header";
      return [
        finding(self, p, {
          source,
          target: used.target,
          ...(used.delaySeconds !== null ? { delaySeconds: used.delaySeconds } : {}),
          selfTarget: normalizeUrl(used.target) === normalizeUrl(p.url),
        }),
      ];
    },
  ),
];

import { finding, pageRule } from "../helpers.js";
import type { PageRule } from "../registry/types.js";

/**
 * Fetch-outcome rules. These are the only page rules with no `isAuditable`
 * guard: the non-ok rows ARE their subject. A URL that failed to fetch is a
 * classified finding, never a page the audit passes over in silence.
 */
const CATEGORY = "status";

export const statusRules: PageRule[] = [
  pageRule("http.server-error", ["CHECK-12"], CATEGORY, "critical", (p, self) =>
    p.fetchClass === "server_error"
      ? [finding(self, p, { statusCode: p.statusCode })]
      : [],
  ),

  pageRule("crawl.blocked", ["CHECK-05"], CATEGORY, "warning", (p, self) =>
    p.fetchClass === "blocked" ? [finding(self, p, { statusCode: p.statusCode })] : [],
  ),
];

import { finding, pageRule } from "../helpers.js";
import type { PageRule } from "../registry/types.js";

/**
 * Fetch-outcome rules. These are the only page rules with no `isAuditable`
 * guard: the non-ok rows ARE their subject. A URL that failed to fetch is a
 * classified finding, never a page the audit passes over in silence.
 *
 * They report under `crawl` rather than a category of their own: what that
 * heading collects is everything about whether the crawler could reach a URL
 * at all, which is where the robots rules land too.
 */
const CATEGORY = "crawl";

export const statusRules: PageRule[] = [
  pageRule("http.server-error", ["CHECK-12"], CATEGORY, "critical", (p, self) =>
    p.fetchClass === "server_error"
      ? [finding(self, p, { statusCode: p.statusCode })]
      : [],
  ),

  // A NOT MEASURED marker, not a site defect. A 401/403/429 or a challenge page
  // aimed at OUR crawler says how this crawl was received; it does not say the
  // page is broken, and CLAUDE.md rule 9 is explicit that being throttled is our
  // bug before it is theirs. So the row is `info` and carries the marker flag:
  // every check on this page is unanswered on this crawl, not answered clean.
  // Whether search engines meet the same wall is the agent's question (CHECK-05).
  // Owner-ruled 2026-09-08 (ruleset 0.12.0): crawl failures are not site issues.
  pageRule(
    "crawl.blocked",
    ["CHECK-05"],
    CATEGORY,
    "info",
    (p, self) =>
      p.fetchClass === "blocked" ? [finding(self, p, { statusCode: p.statusCode })] : [],
    "a page the crawl was refused (bot challenge or access denial), so nothing on it could be judged",
  ),
];

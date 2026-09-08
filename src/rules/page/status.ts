import type { FetchClass } from "../../crawl/fetch-page.js";
import { finding, pageRule } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";

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

/**
 * The recheck classes that mean THE SITE ANSWERED, AND NOT WITH A 5xx.
 * Membership separates a transient blip from a confirmed outage, so every
 * exclusion is deliberate:
 *   server_error   - confirmed, not cleared.
 *   blocked        - an answer about our CRAWLER, not about the page (owner
 *                    ruling, crawl.blocked, ruleset 0.12.0); it clears nothing.
 *   timeout        - no answer at all.
 *   network_error  - no answer at all.
 *   disallowed     - no request was made (url-policy or robots, on recheck).
 *
 * TYPED ON BOTH SIDES ON PURPOSE. The members are `FetchClass`, so a class
 * renamed in `src/crawl/fetch-page.ts` stops compiling here rather than
 * quietly falling out of the cleared set; the declared type is
 * `ReadonlySet<string>`, because the value looked up is `pages.recheck_fetch_class`,
 * a `text` column the type system knows only as `string`.
 */
const RECHECK_CLEARED: ReadonlySet<string> = new Set<FetchClass>([
  "ok",
  "redirect",
  "client_error",
  "non_html",
  "too_large",
  "unsupported_encoding",
]);

/**
 * Did the second look get a non-5xx answer FROM THE SITE?
 *
 * The single predicate the two 5xx rules are defined against, written once and
 * negated by the other: `http.server-error-transient` fires when this is true,
 * `http.server-error` when it is false. That makes them MUTUALLY EXCLUSIVE and
 * JOINTLY EXHAUSTIVE over `fetch_class = 'server_error'` by construction — no
 * 5xx page is ever silent (hard rule 1) and none ever carries two findings —
 * which `test/rules/status.test.ts` asserts over the whole `FETCH_CLASSES`
 * union plus null rather than over a hand-listed sample.
 */
function recheckCleared(p: PageRecord): boolean {
  return p.recheckFetchClass !== null && RECHECK_CLEARED.has(p.recheckFetchClass);
}

/**
 * Which of the four things the recheck columns can be saying, as the word the
 * evidence carries. Four values rather than a boolean because "we never asked",
 * "a budget stopped us", "it is still broken" and "we asked and learned
 * nothing" are four different sentences a report writer needs.
 *
 * `capped` keys on `recheck_reason` being NON-NULL, not on its text. The null
 * contract (src/db/schema.ts) is what says the pass decided not to ask and gave
 * a reason; `recheck-cap` is the only reason at launch, and a second one added
 * later must land here as "the pass decided not to ask" without editing this
 * function or the evidence's vocabulary.
 */
function recheckState(p: PageRecord): "not run" | "capped" | "confirmed" | "inconclusive" {
  if (p.recheckFetchClass === null) return p.recheckReason === null ? "not run" : "capped";
  return p.recheckFetchClass === "server_error" ? "confirmed" : "inconclusive";
}

/**
 * Whole seconds between the two observations, or null when there was no second
 * one — or no first timestamp, which is a row written before migration 0016.
 * Null rather than a zero or a computed guess: a gap nobody measured is not a
 * gap of nothing (hard rule 7).
 */
function gapSeconds(p: PageRecord): number | null {
  if (p.recheckAt === null || p.fetchedAt === null) return null;
  return Math.round((p.recheckAt.getTime() - p.fetchedAt.getTime()) / 1000);
}

export const statusRules: PageRule[] = [
  // A 5xx the recheck did NOT clear: confirmed still broken, rechecked and
  // unknown (timeout, network error, blocked, disallowed), capped by the pass's
  // budget, or never rechecked at all. All four stay `critical` and the
  // `recheck` string in the evidence says which one it is.
  //
  // NO MARKER FOR THE UNVERIFIED CASE, ruled 2026-09-08 (ruleset 0.13.0): a
  // marker means a check could not be ANSWERED, and CHECK-12 was answered — the
  // site returned a server error. Persistence is a qualifier on that answer, not
  // the absence of one, and under-reporting a broken page is the worse mistake.
  pageRule("http.server-error", ["CHECK-12"], CATEGORY, "critical", (p, self) =>
    p.fetchClass === "server_error" && !recheckCleared(p)
      ? [
          finding(self, p, {
            statusCode: p.statusCode,
            recheck: recheckState(p),
            recheckStatusCode: p.recheckStatusCode,
            recheckFetchClass: p.recheckFetchClass,
            recheckReason: p.recheckReason,
            gapSeconds: gapSeconds(p),
          }),
        ]
      : [],
  ),

  // The same 5xx after the site answered the second request with something that
  // is not a 5xx: a blip, not an outage. `warning` rather than `critical`
  // because the page serves now and rather than `info` because an intermittent
  // 5xx still costs crawl rate — and never a marker, because this is a fact
  // about the SITE that two observations settled, not a hole in our evidence.
  pageRule("http.server-error-transient", ["CHECK-12"], CATEGORY, "warning", (p, self) =>
    p.fetchClass === "server_error" && recheckCleared(p)
      ? [
          finding(self, p, {
            statusCode: p.statusCode,
            recheckStatusCode: p.recheckStatusCode,
            recheckFetchClass: p.recheckFetchClass,
            gapSeconds: gapSeconds(p),
          }),
        ]
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

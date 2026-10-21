import { MAX_BODY, type FetchClass } from "../../crawl/fetch-page.js";
import { finding, pageRule } from "../helpers.js";
import type { PageRecord, PageRule } from "../registry/types.js";

/**
 * Fetch-outcome rules. These are the only page rules with no cohort guard at
 * all — neither `isAuditable` nor, since Phase 22 §1, `isJudged`: the non-ok
 * rows ARE their subject. A URL that failed to fetch is a classified finding,
 * never a page the audit passes over in silence, and a 404 is a 404 whatever
 * its canonical or its robots meta would have said.
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
 * EXPORTED because a second reader needs the SAME set, not a copy of it:
 * `crawl_status.recheck.cleared` counts the rows this rule pair would call
 * transient (`recheckCoverage`, src/api/service.ts), and a surface that
 * spelled the six classes out again would answer a different question from the
 * rule the day a seventh joined.
 *
 * TYPED ON BOTH SIDES ON PURPOSE. The members are `FetchClass`, so a class
 * renamed in `src/crawl/fetch-page.ts` stops compiling here rather than
 * quietly falling out of the cleared set; the declared type is
 * `ReadonlySet<string>`, because the value looked up is `pages.recheck_fetch_class`,
 * a `text` column the type system knows only as `string`.
 */
export const RECHECK_CLEARED: ReadonlySet<string> = new Set<FetchClass>([
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
 * The first observations that are NO RESPONSE AT ALL: the request timed out,
 * or the connection or DNS lookup failed. Since Phase 23 (study D2) the recheck
 * pass re-asks these too, and the `http.no-response` pair judges them.
 */
const NO_RESPONSE: ReadonlySet<string> = new Set<FetchClass>(["timeout", "network_error"]);

/**
 * The recheck classes that mean THE SITE GAVE AN HTTP ANSWER to a URL that gave
 * none the first time: `RECHECK_CLEARED` plus two more.
 *
 *   server_error   - a 5xx IS an answer. The server received the request and
 *                    responded; the "no response" this rule pair is about is
 *                    over. That the answer is an error is a fact about the
 *                    page's health, which the Recheck Status Code column carries
 *                    and the copy reads out ("a 4xx, 5xx or redirect means it
 *                    is broken in a different way"). Calling it "still no
 *                    response" would claim a silence the second look disproved.
 *   blocked        - a 401/403/429 or a challenge is an answer too, about our
 *                    crawler rather than the page. Under the 5xx pair it clears
 *                    nothing, because the question there is "is the 5xx still
 *                    there" and a block cannot say. Here the question is "does
 *                    the URL respond at all", and a block says yes.
 *
 * Excluded, deliberately: `timeout` and `network_error` (still no response —
 * confirmed) and `disallowed` (no second request was made, so nothing was
 * learned — inconclusive).
 *
 * EXPORTED for the same reason `RECHECK_CLEARED` is: `crawl_status.recheck`
 * counts the rows `http.no-response-transient` claims off this set, never off a
 * copy of it.
 */
export const NO_RESPONSE_ANSWERED: ReadonlySet<string> = new Set<string>([
  ...RECHECK_CLEARED,
  ...new Set<FetchClass>(["server_error", "blocked"]),
]);

/**
 * Did the second look at a no-response URL get an HTTP answer? The single
 * predicate the no-response pair is defined against, as `recheckCleared` is for
 * the 5xx pair — so the two are mutually exclusive and jointly exhaustive over
 * `fetch_class in ('timeout','network_error')`, asserted over the whole
 * `FETCH_CLASSES` union plus null in test/rules/status.test.ts.
 */
function recheckAnswered(p: PageRecord): boolean {
  return p.recheckFetchClass !== null && NO_RESPONSE_ANSWERED.has(p.recheckFetchClass);
}

/** The recheck classes that CONFIRM a 5xx: the same failure again. */
const CONFIRMS_SERVER_ERROR: ReadonlySet<string> = new Set<FetchClass>(["server_error"]);

/**
 * Which of the four things the recheck columns can be saying, as the word the
 * evidence carries. Four values rather than a boolean because "we never asked",
 * "a budget stopped us", "it is still broken" and "we asked and learned
 * nothing" are four different sentences a report writer needs.
 *
 * `confirming` is the set of recheck classes that mean "the same failure
 * again": `server_error` for a 5xx page, `timeout`/`network_error` for a page
 * that gave no response. Anything else a rule calls this for (its non-cleared
 * half) is `inconclusive`.
 *
 * `capped` keys on `recheck_reason` being NON-NULL, not on its text. The null
 * contract (src/db/schema.ts) is what says the pass decided not to ask and gave
 * a reason; `recheck-cap` is the only reason at launch, and a second one added
 * later must land here as "the pass decided not to ask" without editing this
 * function or the evidence's vocabulary.
 */
function recheckState(
  p: PageRecord,
  confirming: ReadonlySet<string>,
): "not run" | "capped" | "confirmed" | "inconclusive" {
  if (p.recheckFetchClass === null) return p.recheckReason === null ? "not run" : "capped";
  return confirming.has(p.recheckFetchClass) ? "confirmed" : "inconclusive";
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
  pageRule(
    "http.server-error",
    ["CHECK-12"],
    CATEGORY,
    "critical",
    [
      { key: "recheck", label: "Recheck" },
      { key: "recheckStatusCode", label: "Recheck Status Code" },
      { key: "recheckFetchClass", label: "Recheck Fetch Class" },
      { key: "recheckReason", label: "Recheck Reason" },
      { key: "gapSeconds", label: "Recheck Gap (s)" },
    ],
    (p, self) =>
      p.fetchClass === "server_error" && !recheckCleared(p)
        ? [
            finding(self, p, {
              statusCode: p.statusCode,
              recheck: recheckState(p, CONFIRMS_SERVER_ERROR),
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
  pageRule(
    "http.server-error-transient",
    ["CHECK-12"],
    CATEGORY,
    "warning",
    [
      { key: "recheckStatusCode", label: "Recheck Status Code" },
      { key: "recheckFetchClass", label: "Recheck Fetch Class" },
      { key: "gapSeconds", label: "Recheck Gap (s)" },
    ],
    (p, self) =>
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
    [{ key: "fetchReason", label: "Block Reason" }],
    // `fetchReason` is the evidence's own column (Phase 20): the standard
    // columns already carry the URL, the status and "Non-Indexable / Client
    // Error", and what they cannot say is WHICH wall this was — a `cf-mitigated`
    // header, a 401/403/429, a challenge body on a 503. `pages.fetch_reason` is
    // the sentence the fetch layer wrote from the response itself, and it is the
    // difference between "ask the client to allowlist our user agent" and "this
    // URL is behind a login".
    (p, self) =>
      p.fetchClass === "blocked"
        ? [finding(self, p, { statusCode: p.statusCode, fetchReason: p.fetchReason })]
        : [],
    "The site answered the crawler with a bot challenge or access denial, so this page was not read; allowlist the crawler's user agent and crawl again.",
  ),

  // ---- Phase 23 (docs/research/2026-10-21-screaming-frog-study.md, D2) ----
  // Before 0.18.0 a timeout, a network error, an over-cap body and an
  // undecodable body were classified rows that NO rule spoke for: a URL that
  // never answered looked, in the report, exactly like a URL that was fine.
  // That is the silence hard rule 7 forbids. Like every rule in this file they
  // have no cohort guard: the failed fetch IS the subject.

  // No HTTP response at all, and the recheck did not get one either: still
  // timing out or failing to connect (confirmed), no second request because the
  // policy or robots refused it (inconclusive), the shared recheck budget ran
  // out (capped), or no pass reached the row (not run). `critical` on the
  // `http.server-error` argument: a URL that does not answer cannot be crawled
  // or indexed, and NOT a marker, because CHECK-12 was answered — the URL gave
  // no response, which is a fact about the site. The loop already retried these
  // up to MAX_ATTEMPTS before writing the row, so by the time this fires the URL
  // has failed several times a minute or more apart.
  pageRule(
    "http.no-response",
    ["CHECK-12"],
    CATEGORY,
    "critical",
    [
      { key: "recheck", label: "Recheck" },
      { key: "recheckStatusCode", label: "Recheck Status Code" },
      { key: "recheckFetchClass", label: "Recheck Fetch Class" },
      { key: "recheckReason", label: "Recheck Reason" },
      { key: "gapSeconds", label: "Recheck Gap (s)" },
    ],
    (p, self) =>
      p.fetchClass !== null && NO_RESPONSE.has(p.fetchClass) && !recheckAnswered(p)
        ? [
            finding(self, p, {
              statusCode: p.statusCode,
              recheck: recheckState(p, NO_RESPONSE),
              recheckStatusCode: p.recheckStatusCode,
              recheckFetchClass: p.recheckFetchClass,
              recheckReason: p.recheckReason,
              gapSeconds: gapSeconds(p),
            }),
          ]
        : [],
  ),

  // The same URL after the second request got an HTTP answer — ANY answer,
  // including a 5xx or a block (see `NO_RESPONSE_ANSWERED` for why those two
  // count here and not under the 5xx pair). `warning`, on the 5xx-transient
  // argument: the URL responds now, and an intermittent failure to respond
  // still costs crawl rate. The Recheck Status Code column says what the answer
  // was, so a 200 (recovered) and a 404 (broken differently) read apart.
  pageRule(
    "http.no-response-transient",
    ["CHECK-12"],
    CATEGORY,
    "warning",
    [
      { key: "recheckStatusCode", label: "Recheck Status Code" },
      { key: "recheckFetchClass", label: "Recheck Fetch Class" },
      { key: "gapSeconds", label: "Recheck Gap (s)" },
    ],
    (p, self) =>
      p.fetchClass !== null && NO_RESPONSE.has(p.fetchClass) && recheckAnswered(p)
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

  // A 200 HTML page whose decompressed body went past `MAX_BODY`. The crawler
  // stopped reading and kept no body, so nothing on the page was checked —
  // which is a defect of the PAGE, not a hole in our evidence: search engines
  // also stop reading HTML at a size limit, and the copy says so. `critical`
  // per the Phase 23 plan's table, and not a marker for that reason.
  //
  // `statusCode === 200` because `too_large` is only ever reached from `ok`
  // (fetch-page.ts: a non-2xx status wins over the size), and a 2xx that is not
  // 200 is not the case the copy describes. `htmlBytes` is `pages.html_bytes`,
  // which for this class holds the byte count at which reading stopped — the
  // cap itself (`readCapped` sets it to `maxBytes` on truncation); `limit` is
  // the cap read off the constant, so the two columns say the same number and
  // a reader sees why.
  pageRule(
    "page.html-too-large",
    ["CHECK-12"],
    CATEGORY,
    "critical",
    [
      { key: "htmlBytes", label: "Size (bytes)" },
      { key: "limit", label: "Limit (bytes)" },
    ],
    (p, self) =>
      p.fetchClass === "too_large" && p.statusCode === 200
        ? [finding(self, p, { statusCode: p.statusCode, htmlBytes: p.htmlBytes, limit: MAX_BODY })]
        : [],
  ),

  // A NOT MEASURED marker, on `crawl.blocked`'s argument: the server answered in
  // a content-encoding we never asked for and cannot decode, so every check on
  // the page is unanswered on this crawl rather than answered clean. `info`, as
  // the marker contract requires. `fetchReason` is the fetch layer's sentence
  // naming the coding (`unsupported content-encoding (br)`).
  pageRule(
    "crawl.unreadable-encoding",
    ["CHECK-05"],
    CATEGORY,
    "info",
    [{ key: "fetchReason", label: "Encoding" }],
    (p, self) =>
      p.fetchClass === "unsupported_encoding"
        ? [finding(self, p, { statusCode: p.statusCode, fetchReason: p.fetchReason })]
        : [],
    "The page was sent in a compression format the crawler did not request and cannot decode, so nothing on it was checked; crawl it again once the server honours the requested encoding.",
  ),
];

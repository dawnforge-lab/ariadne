/**
 * The 5xx re-verification pass: at crawl end, every page the crawl saw answer
 * "server error" is asked ONE more time, so a finding can say whether the error
 * PERSISTS rather than only that it happened once (P17-T2).
 *
 * The distinction this pass exists to draw is not "was there a 5xx" — the crawl
 * already answered that — but "is it still there a minute later". A deploy, a
 * pool restart or a request-scoped blow-up under momentary load all produce a
 * 503 that is gone by the time anybody reads the report, and today that blip is
 * recorded as a `critical` site issue for life. A second observation is the only
 * thing that can tell those apart, and only a second observation TAKEN BY THIS
 * CRAWL can, because a recheck run days later by an agent is measuring a
 * different site while stamping its answer on a crawl whose findings claim to
 * describe one moment.
 *
 * ## Both observations are kept. The first is never rewritten.
 *
 * The pass writes `recheck_fetch_class`, `recheck_status_code`,
 * `recheck_reason` and `recheck_at`, and NOTHING ELSE. It never touches
 * `fetch_class`, `status_code`, `fetch_reason` or any analysis column, and the
 * reasons are in src/db/schema.ts's "THE TWO OBSERVATIONS" block: `fetch_class`
 * is the census every cohort in this engine is cut from, and a row flipped to
 * `ok` after the fact would be an `ok` page with no title, no words, no links
 * and no simhash — silently exempt from most of the ruleset while looking
 * healthy (hard rules 1 and 7). Two observations are two facts.
 *
 * ## Phase 23: the pages that gave no response at all
 *
 * Since ruleset 0.18.0 (docs/research/2026-10-21-screaming-frog-study.md, D2)
 * the pass also re-asks `timeout` and `network_error` rows — `RECHECK_CLASSES`.
 * Before it, those rows were retried by the loop (up to `MAX_ATTEMPTS`, within
 * seconds of each other) and then judged by no rule at all. The loop's retries
 * answer "was it a dropped packet"; this pass answers what it answers for a
 * 5xx — "is it still like that a minute later" — and the `http.no-response`
 * pair reads the answer. The file and export names keep "server errors"
 * because they are on the Talos surface; the vocabulary is now wider than the
 * name.
 *
 * ## The budget: one request per already-broken page
 *
 * That is the whole reason this pass can be unconditional. Nothing but the
 * `RECHECK_CLASSES` rows is re-fetched — not 4xx (an answer), not `blocked`
 * (owner-ruled a fact about our CRAWLER, not the site), not `non_html` /
 * `too_large` / `unsupported_encoding` (deterministic non-answers). On a healthy
 * site the work list is empty and the pass costs one SQL query.
 *
 * ## Two walks, two budgets: 5xx first, exactly as before Phase 23
 *
 * The pass walks the `server_error` rows FIRST, oldest-first, under
 * `MAX_RECHECKS` (500) — byte-for-byte the pre-Phase-23 behaviour, so a site's
 * no-response rows can never take a seat a 5xx would have had. Only then does it
 * walk the `timeout` / `network_error` rows, oldest-first, under their OWN cap,
 * `NO_RESPONSE_RECHECK_CAP` (100), stamping `recheck-cap` on the rows past it.
 *
 * Why a smaller, separate cap: a 5xx recheck costs one fast answer, a
 * no-response recheck can cost the whole request deadline. And a per-host
 * BREAKER on top of it: after `HOST_UNRESPONSIVE_THRESHOLD` (3) CONSECUTIVE
 * confirmed no-response rechecks on one host — the second look timed out or
 * failed to connect again — that host's remaining no-response rows are stamped
 * `host-unresponsive` (`HOST_UNRESPONSIVE_REASON`) and NOT requested. A host
 * that is down is down; asking it 97 more times proves nothing and costs 97
 * deadlines. "Consecutive" is per host: any HTTP answer from that host resets
 * its count; a refusal by our own policy or robots (no request made) leaves it
 * where it was. Both stamps leave the class null with a reason, which the rule
 * reads as `capped` and a resume re-asks, on the cap's doctrine. The breaker
 * holds one counter per HOST, never a set of URLs — O(hosts), hard rule 6.
 *
 * WORST-CASE WALL TIME the no-response walk adds: at most
 * `NO_RESPONSE_RECHECK_CAP` requests, each bounded by the request deadline
 * (`FETCH_TIMEOUT_MS`, 20 s) plus the host's earned spacing (capped at the
 * gate's 30 s maximum): ≈ 100 × (20 s + 30 s) ≈ 83 minutes, and in practice far
 * less, because the breaker stops a dead host after three. The 5xx walk's bound
 * is unchanged from before the phase.
 *
 * ## The three constants, and why they are these numbers
 *
 *  - **`MIN_RECHECK_GAP_MS = 60_000`.** Three things produce a transient 5xx: a
 *    request-scoped error under momentary load (seconds); an upstream, pool or
 *    container restart, or a deploy (tens of seconds to about two minutes — the
 *    case that matters); and a rate limiter answering 503, which the gate's own
 *    back-off already handles. 30s covers only the front of the second case. 60s
 *    is the smallest number that covers its common shape. 5 minutes would delay
 *    every crawl carrying one 5xx for marginal gain, and would misread what the
 *    finding claims: "still broken an hour later" is a RE-CRAWL's claim, not a
 *    pass's.
 *
 *    THE WAIT IS PAID AT MOST ONCE, NOT PER ROW. The work list is walked
 *    oldest-first, each row's wait is `max(0, fetchedAt + gap - now)`, and that
 *    is monotonically decreasing across the walk — so the total wall time this
 *    pass adds to a crawl is bounded by 60 seconds however many rows it holds.
 *    A row whose `fetched_at` is null (a pre-0016 crawl resumed by a 0016 loop)
 *    counts from the pass's own start instead, which can only bound the gap and
 *    never report it; the finding's `gapSeconds` is then null, the honest answer
 *    rather than a computed number nobody measured.
 *
 *  - **`MAX_RECHECKS = 500`.** More than 500 server errors is a site-wide
 *    outage, not a set of broken pages, and re-asking every one of them buys
 *    nothing a sample would not. Rows past the cap keep `recheck_fetch_class`
 *    null and are stamped with the reason below, in ONE statement at the end.
 *
 *    IT COUNTS ROWS THE PASS SETTLED, NOT REQUESTS IT ISSUED, and a refusal is
 *    a settled row: a URL the policy now forbids or robots.txt now disallows is
 *    written `disallowed` with a reason, no request is made, and it spends one
 *    of the 500 all the same. That is the budget's job — it bounds the WALK,
 *    not the traffic, and a pass that could be refused 500 times and keep
 *    walking would be unbounded on exactly the site that had moved behind a
 *    login.
 *
 *  - **`RECHECK_CAP_REASON = 'recheck-cap'`.** The `RESOURCE_CAP_REASON`
 *    doctrine verbatim, its `&& !aborted` guard included: a budget running out
 *    is a decision the pass made and every row it applies to says so (hard rule
 *    7), while a stop the CALLER made decided nothing about anything and its
 *    rows carry no reason at all. Only the row shape can tell those apart, and a
 *    capped row is still null, so a resume picks it up and overwrites the
 *    reason.
 *
 * ## Where the walls are
 *
 *  - **`isUrlAllowed` explicitly, on every URL, hard rule 5.** `fetchPage`
 *    re-checks the policy internally — belt and braces, not a substitute — but
 *    the explicit call is the one that produces a CLASSIFIED ROW rather than a
 *    throw, and the policy is DNS-dependent: a hostname vetted three hours ago
 *    at enqueue time may now resolve into RFC1918 space.
 *  - **robots.txt, re-asked of the rules we already hold.** The crawl origin's
 *    `RobotsInfo` is passed in rather than re-read; a page that has since been
 *    disallowed is `disallowed` plus a reason and no request. A refusal is a
 *    DECIDED outcome, not an absence.
 *  - **The SAME `HostGate` INSTANCE the page loop used**, never a new one, so a
 *    host that earned 8s of spacing by refusing the page crawl is still at 8s
 *    when we ask it again (hard rule 9). `gate.report` is told about every
 *    request, so a 503 on recheck escalates that host for everything that
 *    follows — including the resource pass, which shares this gate.
 *  - **Strictly sequential. No pool, no `CrawlWindow`, no `maxConcurrency`.**
 *    The work list is empty on a healthy site; a site with many 5xx rows is a
 *    site in trouble, and the last thing to do is open concurrent sockets to it
 *    (the yellow.com.mt incident, docs/talos-integration.md). The whole set is
 *    normally one host, which the gate serialises anyway.
 *  - **The body is discarded, and no links are enqueued.** Analyzing it would
 *    produce a half-analyzed page whose links go nowhere, and writing it would
 *    be the first-observation rewrite this pass exists not to do.
 *  - **No retries.** ONE more fetch. A timeout on the recheck is a `timeout`
 *    row and the finding stays `critical`. A no-response row's second look can
 *    itself hang for the whole `timeoutMs`; the walk is sequential, so the
 *    worst case adds `timeoutMs` per row, bounded by the cap.
 *  - **RAM is O(1)** (hard rule 6): the work list is read in cursor-paged
 *    batches and nothing here holds a set of URLs.
 *
 * ## Resumable the frontier's way
 *
 * Each walk's work list IS `fetch_class in <its classes> and
 * recheck_fetch_class is null` (rows a cap or the breaker stamped included), so an interrupted pass re-run asks exactly the rows the first one never
 * reached and re-asks nothing it settled. An abort leaves BOTH nulls — nothing
 * was decided — and returns `aborted: true` so the crawl loop closes its row
 * stopped (`paused` or `cancelled`) rather than reporting a complete recheck it
 * does not have.
 *
 * ## Not contained
 *
 * Like the resource pass and unlike the 404 probe. Every site-side failure is
 * classified into a row here, so anything this throws is OUR defect or a failed
 * write, and there is no column in which to write "the recheck columns are
 * missing because the writer broke". It propagates, `execute` closes the crawl
 * `failed`, and the operator finds out (hard rule 7).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { pages } from "../../db/schema.js";
import type { RobotsInfo } from "../discovery.js";
import { fetchPage, type FetchClass } from "../fetch-page.js";
import type { HostGate } from "../politeness.js";
import { isUrlAllowed } from "../url-policy.js";
import { storableCap } from "../storable-text.js";

/**
 * The floor under the gap between the two observations. See the module header
 * for why 60 seconds and why the wait is paid once rather than per row.
 */
export const MIN_RECHECK_GAP_MS = 60_000;

/**
 * The first-observation classes this pass re-asks: a 5xx, and the two ways a
 * URL gives no HTTP response at all (Phase 23). EXPORTED because the surfaces
 * that count the pass's coverage (`crawl_status.recheck`, src/api/service.ts)
 * must count over the same rows the pass walks, never over a copy of the list.
 */
export const RECHECK_CLASSES: ReadonlySet<FetchClass> = new Set<FetchClass>([
  "server_error",
  "timeout",
  "network_error",
]);

/**
 * Rows one pass will settle — those it re-asks about AND those it refuses
 * without asking, since a policy or robots refusal is a settled row too. See
 * the module header.
 */
export const MAX_RECHECKS = 500;

/**
 * The reason a row the cap stopped short of carries, while its class stays
 * null. Exported because two readers depend on the literal: this pass's own
 * re-run (which overwrites it when it finally asks) and the surfaces that report
 * `recheck.capped` off the column.
 */
export const RECHECK_CAP_REASON = "recheck-cap";

/** The first-observation class of the FIRST walk. */
const SERVER_ERROR_CLASSES: ReadonlySet<FetchClass> = new Set<FetchClass>(["server_error"]);

/**
 * The first-observation classes of the SECOND walk: no HTTP response at all.
 * `RECHECK_CLASSES` minus the 5xx.
 */
export const NO_RESPONSE_RECHECK_CLASSES: ReadonlySet<FetchClass> = new Set<FetchClass>([
  "timeout",
  "network_error",
]);

/**
 * Rows the no-response walk will settle, on `MAX_RECHECKS`'s terms but its own
 * budget, spent only after every 5xx row. See the module header for why it is
 * separate and smaller.
 */
export const NO_RESPONSE_RECHECK_CAP = 100;

/**
 * Consecutive confirmed no-response rechecks on one host after which that
 * host's remaining no-response rows are stamped `HOST_UNRESPONSIVE_REASON`
 * and not requested. See the module header.
 */
export const HOST_UNRESPONSIVE_THRESHOLD = 3;

/** The reason the breaker stamps, with the class left null. */
export const HOST_UNRESPONSIVE_REASON = "host-unresponsive";

/** The deadline one recheck gets. The crawl loop's own, passed in by it. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Rows read from the work list at a time. Bounds this pass's memory. */
const WORK_BATCH = 200;

/**
 * The longest this pass sleeps without looking at the signal. A single 60s
 * `setTimeout` would mean a stopped crawl sat there for a minute after the
 * caller said stop; "we stopped" has to mean the next quarter-second.
 */
const SLEEP_SLICE_MS = 250;

export interface RecheckPassOpts {
  userAgent: string;
  /**
   * The gate the PAGE crawl used, not a new one. See the module header: this is
   * how a host that earned wider spacing keeps it for its recheck, and how a
   * 503 on recheck escalates that host for the resource pass that follows.
   */
  gate: HostGate;
  /**
   * The crawl origin's robots.txt, already read by `discover`. This pass reads
   * nobody's robots.txt: every URL in its work list is a page THIS crawl
   * fetched, so it is on the origin or one of the same-site spellings
   * `RobotsInfo.isAllowed` already judges against the origin's rules.
   */
  robots: RobotsInfo;
  /** The deadline one recheck gets; the loop passes its own `FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * TEST ONLY. Threaded to url-policy and the connect guard so the suite can
   * re-ask a 127.0.0.1 fixture server. Never wire this to config, an API field
   * or an env var.
   */
  allowPrivate?: boolean;
  /**
   * TEST ONLY override of `MIN_RECHECK_GAP_MS`, on the `robotsRetryBackoffMs`
   * precedent in the resource pass: without it every test that drives this pass
   * would wait a real minute. Production has no reason to move it — the number
   * IS the claim the evidence makes about the gap.
   */
  minGapMs?: number;
  /** TEST ONLY override of `MAX_RECHECKS`, so a cap can be provoked with two rows. */
  maxRechecks?: number;
  /** TEST ONLY override of `NO_RESPONSE_RECHECK_CAP`. */
  maxNoResponseRechecks?: number;
  signal?: AbortSignal;
}

/**
 * What the pass did, for `CrawlSummary.recheck`.
 *
 * DELIBERATELY SMALL, and deliberately not the coverage block `crawl_status`
 * reports. That block is counted LIVE off `pages` (`serverErrors`, `pending`
 * and the rest), because a poller must be able to watch `pending` fall WHILE
 * the pass runs and because a resumed crawl's numbers are the table's, not one
 * run's. These six are the facts only the run itself knows: what THIS pass
 * settled, and whether a budget or a caller stopped it.
 *
 * `confirmed + cleared + inconclusive == rechecked`, always: the three are an
 * exhaustive partition of the `FetchClass` union for each first class (see
 * `outcomeOf`, which the compiler holds to it). The partition is the one the
 * rule pair for that first class draws, so these counts and the findings agree.
 */
export interface RecheckPassSummary {
  /** Rows this pass settled: wrote a `recheck_fetch_class` onto. */
  rechecked: number;
  /**
   * Of those, the same failure again: still 5xx for a 5xx row, still no
   * response (timeout or network error) for a no-response row.
   */
  confirmed: number;
  /**
   * Of those, the transient case: for a 5xx row the site answered and not with
   * a 5xx (`RECHECK_CLEARED`); for a no-response row the site gave any HTTP
   * answer at all, a 5xx or a block included (`NO_RESPONSE_ANSWERED`).
   */
  cleared: number;
  /**
   * Of those, nothing learned. For a 5xx row: a timeout, a network error, a
   * block (an answer about our crawler) or a refusal by our own policy or by
   * robots (no request at all). For a no-response row: only the refusal.
   * Settled rows every one — the pass decided something and said what — but
   * nothing that confirms or clears.
   */
  inconclusive: number;
  /**
   * A budget stopped a walk — `MAX_RECHECKS` on the 5xx walk or
   * `NO_RESPONSE_RECHECK_CAP` on the no-response walk; the rows past it say
   * `recheck-cap`. The breaker's `host-unresponsive` rows do not set it: they
   * are counted in `hostsUnresponsive`.
   */
  capped: boolean;
  /** Hosts the breaker tripped on, whose remaining no-response rows were not asked. */
  hostsUnresponsive: number;
  /**
   * The caller's signal fired and the pass stopped early. Distinct from
   * `capped` in the way it has to be: a cap is a budget the operator set and the
   * rows it stopped at SAY SO, while an abort decided nothing about anything —
   * its rows keep both nulls, `crawls.recheck_pass_at` is not stamped, and the
   * crawl that ran this pass must close stopped (`paused` or `cancelled`), not `finished`
   * (hard rule 7; the loop reads this).
   */
  aborted: boolean;
}

/** One row of the work list. */
interface WorkItem {
  id: string;
  url: string;
  /**
   * The FIRST observation's class, one of `RECHECK_CLASSES`. Read because what
   * a second observation means depends on what the first one was.
   */
  fetchClass: string;
  /** When the FIRST observation was taken. Null on a pre-0016 row. */
  fetchedAt: Date | null;
}

/**
 * Which of the three things a second observation can mean, given the first.
 *
 * For a 5xx row, `serverErrorOutcome`. For a no-response row (`timeout`,
 * `network_error`), `noResponseOutcome`. Each switch is exhaustive over
 * `FetchClass` BY THE COMPILER — the declared return type has no `undefined` in
 * it, so a member added to `FETCH_CLASSES` and not named in both is a typecheck
 * failure rather than a row that silently counts as one of the three.
 *
 * The rule layer holds its own copy of these partitions (`RECHECK_CLEARED` and
 * `NO_RESPONSE_ANSWERED` in src/rules/page/status.ts). The two are the same
 * partitions, and the exhaustiveness guard in each is what keeps them one.
 */
function outcomeOf(
  firstClass: string,
  recheckClass: FetchClass,
): "confirmed" | "cleared" | "inconclusive" {
  if (firstClass === "server_error") return serverErrorOutcome(recheckClass);
  if (firstClass === "timeout" || firstClass === "network_error") {
    return noResponseOutcome(recheckClass);
  }
  // The work list selects RECHECK_CLASSES only; a row outside them here means
  // the query and this function disagree, which is our defect (hard rule 7).
  throw new Error(`recheckServerErrors: no outcome partition for first class '${firstClass}'`);
}

/**
 * A second look at a 5xx. Every exclusion from `cleared` is deliberate:
 *
 *   server_error   confirmed, not cleared.
 *   blocked        an answer about our CRAWLER, not about the page (owner
 *                  ruling, `crawl.blocked`); it clears nothing.
 *   timeout        no answer at all.
 *   network_error  no answer at all.
 *   disallowed     no request was made (url-policy or robots, on recheck).
 */
export function serverErrorOutcome(fetchClass: FetchClass): "confirmed" | "cleared" | "inconclusive" {
  switch (fetchClass) {
    case "server_error":
      return "confirmed";
    case "ok":
    case "redirect":
    case "client_error":
    case "non_html":
    case "too_large":
    case "unsupported_encoding":
      return "cleared";
    case "blocked":
    case "timeout":
    case "network_error":
    case "disallowed":
    case "excluded":
      return "inconclusive";
  }
}

/**
 * A second look at a URL that gave no response. The question is "does it
 * respond at all now", so ANY HTTP answer is `cleared` — a 5xx and a block
 * included, because each is the server responding (see `NO_RESPONSE_ANSWERED`
 * in src/rules/page/status.ts for the argument).
 *
 *   timeout        still no response: confirmed.
 *   network_error  still no response: confirmed.
 *   disallowed     no request was made (url-policy or robots, on recheck).
 */
export function noResponseOutcome(fetchClass: FetchClass): "confirmed" | "cleared" | "inconclusive" {
  switch (fetchClass) {
    case "timeout":
    case "network_error":
      return "confirmed";
    case "ok":
    case "redirect":
    case "client_error":
    case "non_html":
    case "too_large":
    case "unsupported_encoding":
    case "server_error":
    case "blocked":
      return "cleared";
    case "disallowed":
    case "excluded":
      return "inconclusive";
  }
}

function positiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`recheckServerErrors: ${name} must be an integer ≥ 1, got ${value}`);
  }
}

function nonNegativeInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`recheckServerErrors: ${name} must be an integer ≥ 0, got ${value}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A URL's gate key, or null when the string is not a URL at all.
 *
 * `pages.url` was vetted at enqueue time, so null here means the row was edited
 * underneath us. It is not swallowed: the wait simply has no host queue to
 * respect (no request will be issued for it), and `isUrlAllowed` below turns
 * the row into a `disallowed` one with the policy's own words.
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Ask every unrechecked `RECHECK_CLASSES` page of `crawlId` (a 5xx, a timeout,
 * a network error) one more time, and record what it said.
 *
 * Never throws for a site's behaviour — a second 500, a timeout, a WAF that has
 * started refusing us are all classified rows (hard rule 7). It DOES throw for
 * ours: a failed write, an empty user agent, a nonsensical budget. The crawl
 * loop lets those propagate (see the module header).
 */
export async function recheckServerErrors(
  db: Db,
  crawlId: string,
  opts: RecheckPassOpts,
): Promise<RecheckPassSummary> {
  const minGapMs = opts.minGapMs ?? MIN_RECHECK_GAP_MS;
  const maxRechecks = opts.maxRechecks ?? MAX_RECHECKS;
  const maxNoResponseRechecks = opts.maxNoResponseRechecks ?? NO_RESPONSE_RECHECK_CAP;
  nonNegativeInt("minGapMs", minGapMs);
  positiveInt("maxRechecks", maxRechecks);
  positiveInt("maxNoResponseRechecks", maxNoResponseRechecks);
  if (opts.userAgent.trim() === "") {
    throw new Error("recheckServerErrors: userAgent must not be empty (rule 9: branded UA)");
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPrivate = opts.allowPrivate === true;
  const gate = opts.gate;
  /** The floor a row with no `fetched_at` counts its gap from. See the header. */
  const passStart = Date.now();
  /**
   * The signal, read through a call rather than inline, so the compiler cannot
   * narrow one check into an assumption about a later one: the flag is set by
   * the caller between two of our awaits, which is exactly the case
   * control-flow analysis assumes cannot happen.
   */
  const isAborted = (): boolean => opts.signal?.aborted === true;

  let rechecked = 0;
  let confirmed = 0;
  let cleared = 0;
  let inconclusive = 0;
  let hostsUnresponsive = 0;

  /** Write one settled row, and count what it settled to. */
  const settle = async (
    item: WorkItem,
    fetchClass: FetchClass,
    statusCode: number | null,
    reason: string | null,
  ): Promise<void> => {
    // Before the write, so a row outside every partition throws without
    // having been settled.
    const outcome = outcomeOf(item.fetchClass, fetchClass);
    await db
      .update(pages)
      .set({
        recheckFetchClass: fetchClass,
        recheckStatusCode: statusCode,
        // A reason can quote the site (a Location, a robots line): it passes
        // the storability boundary (ruling R10). Clean text is unchanged.
        recheckReason: reason === null ? null : storableCap(reason),
        // Moves with the class: `recheck_at is null` <=> `recheck_fetch_class
        // is null` over the whole table, which migration-0016's test asserts.
        recheckAt: new Date(),
      })
      .where(eq(pages.id, item.id));
    rechecked += 1;
    switch (outcome) {
      case "confirmed":
        confirmed += 1;
        break;
      case "cleared":
        cleared += 1;
        break;
      case "inconclusive":
        inconclusive += 1;
        break;
    }
  };

  /**
   * Sleep until `target`, in slices, and say whether we got there. False means
   * the caller's signal fired on the way.
   */
  const waitUntil = async (target: number): Promise<boolean> => {
    for (;;) {
      if (isAborted()) return false;
      const remaining = target - Date.now();
      if (remaining <= 0) return true;
      await sleep(Math.min(remaining, SLEEP_SLICE_MS));
    }
  };

  /**
   * One walk over the unsettled rows of `classes`, oldest first, settling at
   * most `cap` rows. Cursor-paged so nothing accumulates (hard rule 6). Returns
   * whether the cap stopped it; an abort is read by the caller.
   *
   * `breaker` is the no-response walk's per-host circuit breaker (see the module
   * header): `streak` holds one counter per host and `tripped` one entry per
   * tripped host — O(hosts), never O(URLs).
   */
  const walkClasses = async (
    classes: ReadonlySet<FetchClass>,
    cap: number,
    breaker: boolean,
  ): Promise<boolean> => {
    let settledHere = 0;
    const streak = new Map<string, number>();
    const tripped = new Set<string>();
    let cursor: WorkItem | null = null;
    for (;;) {
      if (isAborted()) return false;
      const batch = await workList(db, crawlId, classes, cursor, WORK_BATCH);
      if (batch.length === 0) return false;
      cursor = batch[batch.length - 1]!;

      for (const item of batch) {
        // The caller's stop, honoured per ROW rather than per batch, and again
        // inside the wait. The row is left exactly as it was: both nulls, nothing
        // decided, and it is the resume's work list.
        if (isAborted()) return false;

        const host = hostOf(item.url);

        // THE BREAKER, before the wait and before the budget: a row on a host
        // that has stopped answering is stamped and never requested, so it costs
        // neither a deadline nor a seat. Class stays null, reason non-null — the
        // cap's doctrine, which the rule reads as `capped` and a resume re-asks.
        if (breaker && host !== null && tripped.has(host)) {
          await db
            .update(pages)
            .set({ recheckReason: HOST_UNRESPONSIVE_REASON })
            .where(and(eq(pages.id, item.id), isNull(pages.recheckFetchClass)));
          continue;
        }

        // The gap this row owes, counted from ITS OWN first observation, with the
        // host's earned spacing as the other floor — `MIN_RECHECK_GAP_MS` is a
        // floor ON TOP of the gate's spacing, never instead of it (rule 9).
        const base = item.fetchedAt?.getTime() ?? passStart;
        const wait = Math.max(minGapMs, host === null ? 0 : gate.spacingMs(host));
        if (!(await waitUntil(base + wait))) return false;

        // After the wait, because the budget is about requests we are about to
        // make and the wait may have been a minute long.
        if (settledHere >= cap) return true;

        // Hard rule 5, explicitly and every time. The policy is DNS-dependent and
        // this URL was last vetted when it was enqueued; a refusal here is a
        // classified row rather than the throw `fetchPage` would raise. A refusal
        // made no request, so it leaves the breaker's streak where it was.
        const policy = await isUrlAllowed(item.url, { allowPrivate });
        if (!policy.allowed) {
          await settle(item, "disallowed", null, policy.reason ?? "refused by the URL policy");
          settledHere += 1;
          continue;
        }
        if (!opts.robots.isAllowed(item.url)) {
          await settle(
            item,
            "disallowed",
            null,
            opts.robots.note ?? `robots.txt (${host ?? "origin"}) disallows this URL`,
          );
          settledHere += 1;
          continue;
        }

        // `host` is non-null from here: the policy accepted the URL, which it
        // cannot do for a string `new URL` refused.
        const gateHost = host ?? new URL(item.url).host;
        // The signal wakes the slot wait (Phase 27b): a stop under a long
        // spacing is noticed now, not when the slot comes due. Aborted, the row
        // is left exactly as it was, and the pass reports `aborted`.
        if (!(await gate.acquire(gateHost, opts.signal))) return false;
        const result = await fetchPage(item.url, {
          userAgent: opts.userAgent,
          allowPrivate,
          timeoutMs,
        });
        // The gate hears about it before anything else does, so a 503 on recheck
        // escalates this host for whatever comes next — the rest of this pass, and
        // the resource pass that shares this gate.
        gate.report(gateHost, {
          fetchClass: result.fetchClass,
          statusCode: result.statusCode,
          retryAfterMs: result.retryAfterMs,
          url: item.url,
        });
        // `result.body` is dropped on this line and never read: see the header.
        await settle(item, result.fetchClass, result.statusCode, result.disallowedReason);
        settledHere += 1;

        if (breaker) {
          // CONSECUTIVE per host: a confirmed no-response adds one, any HTTP
          // answer from the host resets it.
          if (noResponseOutcome(result.fetchClass) === "confirmed") {
            const now = (streak.get(gateHost) ?? 0) + 1;
            streak.set(gateHost, now);
            if (now >= HOST_UNRESPONSIVE_THRESHOLD && !tripped.has(gateHost)) {
              tripped.add(gateHost);
              hostsUnresponsive += 1;
            }
          } else {
            streak.set(gateHost, 0);
          }
        }
      }
    }
  };

  /**
   * Loud, not silent: every row a cap stopped short of says so, in ONE
   * statement rather than one per row. Called only when the walk was capped AND
   * not aborted — an abort's rows were not capped, they were interrupted, and
   * stamping a reason on them would claim a decision nobody made
   * (`RESOURCE_CAP_REASON`, P12-T2 review C-1). `recheck_reason is null` keeps
   * it idempotent and off a row an earlier run, or the breaker, already claimed.
   */
  const stampCap = async (classes: ReadonlySet<FetchClass>): Promise<void> => {
    await db
      .update(pages)
      .set({ recheckReason: RECHECK_CAP_REASON })
      .where(
        and(
          eq(pages.crawlId, crawlId),
          inArray(pages.fetchClass, [...classes]),
          isNull(pages.recheckFetchClass),
          isNull(pages.recheckReason),
        ),
      );
  };

  // WALK 1: the server errors, exactly as before Phase 23 — oldest first,
  // `MAX_RECHECKS`, no breaker.
  // `capped` is reported only for a cap that was STAMPED: a cap the abort
  // pre-empted decided nothing, and the two flags must not claim one stop.
  let capped = false;
  if (await walkClasses(SERVER_ERROR_CLASSES, maxRechecks, false)) {
    if (!isAborted()) {
      await stampCap(SERVER_ERROR_CLASSES);
      capped = true;
    }
  }

  // WALK 2: the no-response rows, only after every 5xx row, under their own
  // budget and the per-host breaker.
  if (
    !isAborted() &&
    (await walkClasses(NO_RESPONSE_RECHECK_CLASSES, maxNoResponseRechecks, true)) &&
    !isAborted()
  ) {
    await stampCap(NO_RESPONSE_RECHECK_CLASSES);
    capped = true;
  }

  // Read once, at the end: the signal may have fired inside the wait rather than
  // at a row boundary, and the caller has to be able to tell "the pass finished"
  // from "the pass was stopped".
  const aborted = isAborted();

  return { rechecked, confirmed, cleared, inconclusive, capped, hostsUnresponsive, aborted };
}

/**
 * The next slice of one walk's work list: this crawl's rows of `classes` that
 * no pass has settled, OLDEST FIRST — the order that walk's cap is spent in.
 *
 * The order is not cosmetic — it is what makes the 60-second wait cost 60
 * seconds instead of 60 per row (see the module header). `fetched_at` is
 * nullable, and `nulls first` is spelled as `coalesce(..., '-infinity')` so the
 * ORDER BY and the keyset comparison are the same expression: a cursor over a
 * column whose ordering rule lives in one place and whose comparison lives in
 * another is how a paged walk silently skips rows.
 *
 * `id` breaks the tie, so the pair is unique and no row can be visited twice or
 * stepped over. The cursor is needed even though every settled row leaves the
 * work list: the rows the cap leaves behind do not, and a cursorless re-query
 * would hand them back for ever. An unparseable URL is not one of them — it is
 * settled `disallowed` by `isUrlAllowed` and leaves the list like any other.
 */
async function workList(
  db: Db,
  crawlId: string,
  classes: ReadonlySet<FetchClass>,
  cursor: WorkItem | null,
  limit: number,
): Promise<WorkItem[]> {
  const result = await db.execute<{
    id: string;
    url: string;
    fetch_class: string;
    fetched_at: string | null;
  }>(
    sql`select id, url, fetch_class, fetched_at
          from pages
         where crawl_id = ${crawlId}
           and fetch_class in ${[...classes]}
           and recheck_fetch_class is null
           ${
             cursor === null
               ? sql``
               : sql`and (coalesce(fetched_at, '-infinity'::timestamptz), id)
                       > (coalesce(${cursor.fetchedAt}::timestamptz, '-infinity'::timestamptz),
                          ${cursor.id})`
           }
         order by coalesce(fetched_at, '-infinity'::timestamptz) asc, id asc
         limit ${limit}`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    url: row.url,
    fetchClass: row.fetch_class,
    // A STRING, not a Date: `db.execute` hands back postgres's own text form
    // (`2026-09-08 14:14:37.642+00`) rather than the Date the query builder's
    // column mappers produce (src/api/csv.ts says the same of its own views).
    // So the conversion is LOAD-BEARING, not cosmetic — `item.fetchedAt` is
    // read as `.getTime()` when the gap is computed, which a string has not
    // got. The null stays null.
    fetchedAt: row.fetched_at === null ? null : new Date(row.fetched_at),
  }));
}

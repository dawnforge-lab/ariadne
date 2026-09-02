/**
 * The resource fetch pass: the crawl asks the site's servers about the files its
 * pages point at — images, stylesheets, scripts — and writes what they say onto
 * the `resources` rows the analyzer left behind (P11-T2).
 *
 * Metadata only. No body is ever kept: a HEAD answers most questions, and the
 * one case that needs a GET streams the body into a counter and throws every
 * chunk away. RAM is O(concurrency), never O(URLs) (hard rule 6) — the work list
 * is read in cursor-paged batches, the host census is bounded by
 * `maxResourceHosts`, and nothing here holds a set of resource URLs.
 *
 * ## The politeness arithmetic, which is the point of this module
 *
 * A crawl that grew resource fetching must not become a crawl that hits harder.
 * It does not, and the reason is one sentence: **every resource request takes a
 * slot from the same per-host gate the pages took slots from, so the REQUEST
 * RATE per host is unchanged and only the wall time grows.**
 *
 * Concretely, for a crawl of P pages carrying R distinct resources on the
 * origin, at a configured spacing of D milliseconds:
 *
 *   before   P slots on the origin's queue          → ~P·D of wall time
 *   after    P + R + G slots on the same queue      → ~(P+R+G)·D of wall time
 *
 * where G ≤ R is the number of resources whose server could not answer a HEAD
 * (405/501, or a 200 with no `content-length`) and therefore cost one extra
 * counted GET. The origin sees a request every D milliseconds before and after;
 * what changes is how long we are there. A third-party asset host gets a queue
 * of its OWN at the same spacing — it is somebody else's server, and the crawl's
 * configured delay is the floor under how fast we may ask it anything — plus one
 * robots.txt read (up to three attempts on a failing host, discovery's own
 * retry discipline). Its own `Crawl-delay`, if it declares one, RAISES that
 * floor for that host alone (`HostGate.raiseHostFloor`).
 *
 * ## Which adaptive halves carry over, and how — they are not one thing
 *
 * The politeness machinery has two independent halves (see ../politeness.ts),
 * and each reaches this pass by its own route. Saying "the adaptive half
 * carries over" would be one word short of true:
 *
 *  - **The spacing half carries itself.** This pass is handed the SAME
 *    `HostGate` INSTANCE the page loop used, so every ratchet that host earned
 *    is already in it: a host at 8s for answering 429 to the page crawl is at 8s
 *    when we ask about its images, and a 429 on an image escalates it further,
 *    into the same state a later resume would read. That is why the gate is a
 *    parameter and not something built here.
 *  - **The concurrency half is threaded, because it cannot carry itself.**
 *    `CrawlWindow` is the loop's, its adapted size lives in that object, and
 *    this pass runs its own worker pool. So the loop passes
 *    `min(window.size(), maxConcurrency)` as `maxConcurrency` (loop.ts,
 *    INSERTION 3b): a site that pushed the window from 4 down to 1 during the
 *    page crawl gets ONE resource worker, not four. Nothing in the per-host
 *    letter of the law would have required that — spacing already serialises a
 *    single host — but a struggling origin that just told us to slow down must
 *    not have us open four sockets to it the moment the pages are done (rule 9,
 *    and the yellow.com.mt incident in docs/talos-integration.md).
 *
 * What does NOT carry is the window's continued adaptation: this pass does not
 * grow or shrink the number it was given. It is a bounded epilogue over a known
 * work list, and a second adaptive controller reacting to HEAD latencies would
 * be a second policy arguing with the gate's. Back-pressure during the pass is
 * the gate's job, and it does escalate.
 *
 * ## Where the walls are
 *
 * - **url-policy on every URL, on READ.** `resources.url` is stored UNVETTED —
 *   it is whatever a page's markup pointed at, resolved — so a row may name
 *   `http://192.168.1.1/x.png` or the cloud metadata service. The policy runs
 *   here, before any socket, and again on every redirect hop, and the connect
 *   layer re-checks the address it actually dials (`sharedAgent`'s guarded
 *   lookup). Hard rule 5 is not a check the analyzer made once; it is a check
 *   this pass makes every time it is about to ask.
 * - **robots.txt per host.** The crawl origin's rules are already loaded, and
 *   are passed in rather than re-read. A third-party host's are fetched once,
 *   politely, and cached for the crawl. Disallowed is `robots_denied` and no
 *   request; a host that could not tell us its rules is `robots_unreachable`
 *   and also no request (RFC 9309 §2.3.1.4 — the same complete disallow, said
 *   as the different fact it is). Googlebot honours robots.txt for assets; so
 *   do we.
 * - **Caps are loud** (hard rule 7). `maxResources` and `maxResourceHosts` leave
 *   rows UNFETCHED — `fetch_class` still null, "seen, not yet asked" — with
 *   `fetch_reason = 'resource-cap'` saying who stopped short, and the summary
 *   counts them.
 * - **A dead host is parked.** Three consecutive transport failures and the rest
 *   of that host's rows are recorded `fetch_error` without being asked. No
 *   unbounded retries against a server that is not answering.
 *
 * ## Resumable the frontier's way
 *
 * The work list IS the null `fetch_class` column. An interrupted pass leaves
 * nulls; running it again asks exactly those and nothing else, so a re-run after
 * a crash costs the rows that were never asked and re-asks nothing that was.
 * That also makes a capped run resumable with a bigger budget: a `resource-cap`
 * row is still null, so a later run picks it up and overwrites the reason.
 *
 * An ABORT is the same shape, deliberately. `signal` is checked before every
 * request — not once per batch, which at a 30s spacing would be minutes of
 * asking after the caller said stop — and the rows it leaves get NO reason,
 * because nothing decided anything about them. The summary says `aborted: true`
 * so the crawl loop can close its row `cancelled` rather than reporting a
 * finished crawl with a silently incomplete resource census (hard rule 7).
 */
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { request } from "undici";
import type { Db } from "../../db/client.js";
import { resources } from "../../db/schema.js";
import { fetchRobots, type RobotsInfo, type RobotsOutcome } from "../discovery.js";
import { classifyStatus, parseRetryAfter, type FetchClass } from "../fetch-page.js";
import {
  ACCEPT_ENCODING,
  blockedAddressMessage,
  describeError,
  headerValue,
  isProgrammerError,
  isTimeout,
  sharedAgent,
  type HeaderBag,
} from "../http.js";
import { isSameOrigin } from "../parse/url-utils.js";
import type { HostGate } from "../politeness.js";
import { isUrlAllowed } from "../url-policy.js";

/**
 * How a resource fetch ended, stored in `resources.fetch_class`. The page
 * vocabulary's shape, narrowed to what a metadata-only fetch can distinguish,
 * plus the one class only a resource can earn:
 *
 *  - `ok` / `client_error` / `server_error` — the server answered.
 *  - `fetch_error` — it did not: a timeout, a reset, a DNS failure. The page
 *    path splits those into `timeout` and `network_error` because it retries
 *    them; this pass does not retry (a resource is not worth three requests),
 *    so one class carries them and `fetch_reason` says which it was.
 *  - `refused` — the URL policy said no, before or during the chain.
 *  - `robots_denied` — the host's own robots.txt said no. It was READ, and it
 *    forbade this URL.
 *  - `robots_unreachable` — the host could not tell us its rules (5xx, timeout,
 *    network error, or a robots URL our own policy refused), and RFC 9309
 *    §2.3.1.4 makes that a complete disallow. The OUTCOME is identical to
 *    `robots_denied` — no request is made — and the FACT is not, which is why it
 *    is a class of its own (P12-T1; the argument is docs/gates/phase-11.md
 *    §10.2). "A CDN that forbids us" and "a CDN that was down while we ran" are
 *    two different sentences about a client's site, and a count that cannot tell
 *    them apart is a count somebody will read as the wrong one.
 *
 * The split is taken off `RobotsInfo.outcome`, a CLOSED VOCABULARY the deny site
 * already holds, and NEVER off the reason sentence. Phase 11 measured the
 * alternative and refused it: a count built by prose-matching `fetchReason`
 * goes silently to zero the day somebody rewords an error message.
 *
 * A `blocked` page (401/403/429) lands here as `client_error`, and a challenge
 * 503 as `server_error`: the STATUS is what the row records, while the block
 * itself is what the gate is told about (see `reportToGate`) — the ratchet needs
 * it, the rules need the status.
 */
export const RESOURCE_FETCH_CLASSES = [
  "ok",
  "client_error",
  "server_error",
  "fetch_error",
  "refused",
  "robots_denied",
  "robots_unreachable",
] as const;

export type ResourceFetchClass = (typeof RESOURCE_FETCH_CLASSES)[number];

/**
 * The three members of that vocabulary a READER outside this module has to
 * name, exported as typed constants so a rename cannot pass a typecheck.
 *
 * The reason is a real failure mode rather than tidiness. Every consumer of this
 * column reads it in SQL, where the class is a bare string: `service.ts`'s
 * coverage aggregate, the resource rules' `filter (where fetch_class = 'ok')`,
 * and the test fixtures that seed rows. Rename a member of
 * `RESOURCE_FETCH_CLASSES` and the WRITER in this file is type-checked into
 * agreement while every one of those readers keeps the old literal — the suite
 * stays green (the fixtures were renamed too, or they were not and their rows
 * simply stop matching), and `crawl_status` starts reporting `robotsDenied: 0`
 * for ever. A count that can silently become 0 while nothing fails is the
 * defect this repository writes paragraphs about.
 *
 * Typed as `ResourceFetchClass`, so the compiler checks them against the list
 * above; interpolated into the SQL, so the string a reader compares against is
 * the string this file writes. Same discipline as `RESOURCE_CAP_REASON` below,
 * which `service.ts` already imports rather than spelling out.
 *
 * Only these are exported because only these are read elsewhere. A fourth
 * reader adds a fourth constant here rather than a fourth literal there.
 */
export const RESOURCE_OK_CLASS: ResourceFetchClass = "ok";
export const RESOURCE_ROBOTS_DENIED_CLASS: ResourceFetchClass = "robots_denied";
export const RESOURCE_ROBOTS_UNREACHABLE_CLASS: ResourceFetchClass = "robots_unreachable";

/**
 * The reason a row that a cap stopped short of carries. A single literal
 * because two readers depend on it: the pass's own re-run (which overwrites it
 * when it finally asks) and the surfaces that report coverage.
 */
export const RESOURCE_CAP_REASON = "resource-cap";

/**
 * The reason a row carries when the OPERATOR turned the pass off
 * (`CrawlConfig.fetchResources: false`, P11-T4).
 *
 * ## Why the rows exist at all, and why they are stamped
 *
 * Turning the pass off does not turn the ANALYZER off: the page parse still
 * emits the references and `PageWriter` still records them, because that costs
 * nobody a request and the census — how many distinct files this site's HTML
 * points at — is real evidence in its own right. What is off is the asking.
 *
 * So the rows sit there with a null `fetch_class`, which on its own is
 * indistinguishable from a pass that was interrupted, from a crawl that predates
 * the pass, and from a cap that stopped short. Those are four different
 * sentences about our evidence and a reader has to be able to tell them apart
 * (hard rule 7), so the decision is written on every row it applies to — the
 * same discipline `RESOURCE_CAP_REASON` follows, for the same reason.
 *
 * It is deliberately NOT a `fetch_class`: no fetch was attempted and no verdict
 * was reached, so the null stands and the reason explains it. A rule that judges
 * a resource still sees "unknown", which is exactly right.
 */
export const RESOURCE_OFF_REASON = "resource-fetch-off";

/**
 * The budgets, and why they are these numbers.
 *
 * `maxResources` 10_000: a 3000-page site of the kind this engine is built for
 * carries a few thousand distinct files after dedup, so the cap is a guard
 * against a pathological site (a CMS that fingerprints every image per page),
 * not a routine ceiling. At the proven 2000ms spacing it is also ~5.5 hours of
 * wall time, which is the real limit an operator is agreeing to.
 *
 * `maxResourceHosts` 20: a normal site's assets sit on its own origin plus a
 * handful of CDNs. Twenty is generous for that and small enough that a page
 * injecting a hundred tracking domains cannot turn one crawl into a hundred
 * conversations with servers nobody asked us to talk to.
 *
 * WHAT `maxResources` COUNTS IS ROWS CONSIDERED, NOT FILES ASKED ABOUT: a row
 * the URL policy refused and a row robots.txt denied both spend a unit of the
 * budget without a request being made. That is the honest meaning for a budget
 * whose job is to bound the pass — a site that fills its markup with refused
 * URLs must not be able to make the pass walk past the cap for free — and it is
 * why the cap is not a promise about how many requests were issued. That number
 * is `ResourcePassSummary.requests`.
 */
export const RESOURCE_DEFAULTS = {
  maxResources: 10_000,
  maxResourceHosts: 20,
} as const;

/** The deadline one resource request gets. Matches the crawl loop's. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Rows read from the work list at a time. Bounds this pass's memory. */
const WORK_BATCH = 200;

/** Redirect hops one resource may take. `discovery`'s number, for one policy. */
const MAX_RESOURCE_REDIRECTS = 5;

/**
 * Requests one row may cost in total: its redirect chain, plus the HEAD and the
 * one counted GET at the end of it. A hard bound, so no chain of 405s and
 * redirects can turn one image into an unbounded conversation.
 */
const MAX_ROW_REQUESTS = MAX_RESOURCE_REDIRECTS + 2;

/** Consecutive transport failures after which a host's queue is parked. */
const DEAD_HOST_ERRORS = 3;

/**
 * The ceiling on a counted GET. Nothing is buffered, so this is not a memory
 * guard — it is a BANDWIDTH guard on someone else's server: a 200MB file we
 * only wanted the size of is 200MB of their egress. Past it the socket is
 * destroyed and the row says the number is a floor rather than a measurement
 * (hard rule 7 — the alternative is a `bytes` that silently means something
 * else on one row in ten thousand).
 */
const MAX_COUNTED_BYTES = 16 * 1024 * 1024;

export interface ResourcePassOpts {
  /** The crawl's seed URL: what makes a resource same-origin or third-party. */
  siteUrl: string;
  userAgent: string;
  /**
   * The gate the PAGE crawl used, not a new one. See the module header: this is
   * how a host that earned wider spacing keeps it for its resources.
   */
  gate: HostGate;
  /** The crawl origin's robots.txt, already read by `discover`. */
  originRobots: RobotsInfo;
  /**
   * Workers across hosts. Per-host order is the gate's business, not this.
   *
   * The crawl loop passes `min(window.size(), config.maxConcurrency)` — the
   * SETTLED window, not the configured ceiling — so an origin that shrank the
   * page crawl's concurrency keeps it shrunk for its resources. See the module
   * header on which halves of the politeness machinery carry and how.
   */
  maxConcurrency: number;
  maxResources?: number;
  maxResourceHosts?: number;
  timeoutMs?: number;
  /**
   * Ceiling on a counted GET's body, default `MAX_COUNTED_BYTES`. An option
   * rather than a constant only so the suite can provoke the truncation branch
   * without streaming 16MiB through a fixture server; production has no reason
   * to move it, and moving it changes what `bytes` means on a very large file
   * (see the constant).
   */
  maxCountedBytes?: number;
  /**
   * TEST ONLY. Threaded to url-policy and the connect guard so the suite can
   * ask a 127.0.0.1 fixture server about its own images. Never wire this to
   * config, an API field or an env var.
   */
  allowPrivate?: boolean;
  /** Backoff between a third-party robots.txt's retries. Lowered by tests. */
  robotsRetryBackoffMs?: number;
  signal?: AbortSignal;
}

/**
 * What the pass did, for `CrawlSummary` and (P11-T4) `crawl_status`.
 *
 * `seen` is every resource row the crawl holds — what the analyzer found — while
 * the other three describe THIS run. On a first run over a complete work list
 * they add up to `seen`; on a re-run of a partially-finished pass they do not,
 * and that is the honest arithmetic rather than a defect: `fetched + failed` is
 * what this run asked, and `skipped` is what is still unasked afterwards.
 */
export interface ResourcePassSummary {
  /** Rows in `resources` for this crawl, fetched or not. */
  seen: number;
  /** Rows this run classified `ok`. */
  fetched: number;
  /** Rows this run classified anything else. */
  failed: number;
  /** Rows still unfetched when the run ended — caps, or an abort. */
  skipped: number;
  /** Distinct hosts this run talked to. */
  hosts: number;
  /** HTTP requests this run issued, robots.txt reads included. */
  requests: number;
  cappedByResources: boolean;
  cappedByHosts: boolean;
  /**
   * The caller's signal fired and the pass stopped early. Distinct from the two
   * cap flags in the way it has to be: a cap is a budget the operator set and
   * the rows it stopped at SAY SO (`fetch_reason: 'resource-cap'`), while an
   * abort decided nothing about anything — its rows carry no reason, and the
   * crawl that ran this pass must close `cancelled` rather than `finished`
   * (hard rule 7; the loop reads this).
   */
  aborted: boolean;
}

/** One row of the work list. */
interface WorkItem {
  url: string;
}

/** What the pass decided about one row. */
interface Verdict {
  /** Null means UNFETCHED — a cap stopped short of asking. */
  fetchClass: ResourceFetchClass | null;
  fetchReason: string | null;
  statusCode: number | null;
  contentType: string | null;
  bytes: number | null;
  bytesSource: "header" | "counted" | null;
  cacheControl: string | null;
  expires: string | null;
  fetchMs: number | null;
}

/** What the pass remembers about one host. O(hosts), capped. */
interface HostRecord {
  /**
   * The host's rules, as a promise so that concurrent workers arriving at a new
   * host share ONE robots.txt request rather than racing to make several.
   */
  robots: Promise<RobotsInfo>;
  /** Consecutive transport failures. Any answer resets it. */
  consecutiveErrors: number;
  /** Why this host's queue was parked, or null while it is alive. */
  parked: string | null;
}

/** A settled request: an answer, or the reason there was none. */
type Attempt =
  | {
      kind: "response";
      statusCode: number;
      headers: HeaderBag;
      /** Counted body bytes; null unless this was a counting GET. */
      counted: number | null;
      /** Set when the counter stopped at MAX_COUNTED_BYTES. */
      countTruncated: boolean;
    }
  | { kind: "refused"; reason: string }
  | { kind: "error"; reason: string; fetchClass: Extract<FetchClass, "timeout" | "network_error"> };

function positiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`fetchCrawlResources: ${name} must be an integer ≥ 1, got ${value}`);
  }
}

/**
 * Ask every unfetched resource of `crawlId` what it is, politely, and record the
 * answers.
 *
 * Never throws for a site's behaviour — a 404, a reset, a refusing WAF are all
 * classified rows (hard rule 7). It DOES throw for ours: a failed write, a
 * malformed user agent, a URL the policy cannot parse into a host. The crawl
 * loop lets those propagate, exactly as it does for the template inference.
 */
export async function fetchCrawlResources(
  db: Db,
  crawlId: string,
  opts: ResourcePassOpts,
): Promise<ResourcePassSummary> {
  const maxResources = opts.maxResources ?? RESOURCE_DEFAULTS.maxResources;
  const maxHosts = opts.maxResourceHosts ?? RESOURCE_DEFAULTS.maxResourceHosts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  positiveInt("maxResources", maxResources);
  positiveInt("maxResourceHosts", maxHosts);
  positiveInt("maxConcurrency", opts.maxConcurrency);
  if (opts.userAgent.trim() === "") {
    throw new Error("fetchCrawlResources: userAgent must not be empty (rule 9: branded UA)");
  }

  const allowPrivate = opts.allowPrivate === true;
  const maxCountedBytes = opts.maxCountedBytes ?? MAX_COUNTED_BYTES;
  positiveInt("maxCountedBytes", maxCountedBytes);
  const gate = opts.gate;
  /**
   * The census, KEYED BY `URL.host` (name plus port) — the gate's key, so a
   * host's spacing and its place in this map are the same host.
   *
   * The robots decision inside each record is ORIGIN-aware while the key is
   * not, and the one place that matters is a site served over both schemes:
   * `http://x/` and `https://x/` share a key, so whichever spelling arrives
   * first decides which `RobotsInfo` the other inherits. That is deliberate and
   * it is the FRONTIER's notion of a site, not a shortcut — `isSameOrigin`
   * admits an http→https upgrade as one origin and `RobotsInfo.isAllowed`
   * rewrites a same-site spelling onto the origin robots.txt was read from
   * (`onRulesOrigin`, ../discovery.ts), precisely so a second spelling cannot
   * be a way around a `Disallow`. A resource host reached under two schemes is
   * one host with one set of rules here for the same reason a page host is.
   */
  const hosts = new Map<string, HostRecord>();

  let fetched = 0;
  let failed = 0;
  let requests = 0;
  let budget = maxResources;
  let cappedByResources = false;
  let cappedByHosts = false;

  /**
   * The host census, the robots cache and the cap, in one place because they
   * are one decision: may we talk to this host at all, and under what rules.
   */
  const admit = async (
    host: string,
    url: string,
  ): Promise<
    | { kind: "capped" }
    | { kind: "parked"; reason: string }
    // `outcome` rides along because the CALLER writes the class and this is
    // where the discriminant exists. Carrying the enum rather than a
    // pre-computed class keeps one decision in one place: `admit` answers "may
    // we ask, and on what evidence", `processOne` turns that into a row.
    | { kind: "denied"; reason: string; outcome: RobotsOutcome }
    | { kind: "ok" }
  > => {
    let record = hosts.get(host);
    if (record === undefined) {
      if (hosts.size >= maxHosts) {
        cappedByHosts = true;
        return { kind: "capped" };
      }
      record = {
        // The origin's rules are already in hand; a third-party host's cost one
        // read, paced by the gate like everything else. An unreachable
        // robots.txt is a complete disallow, not permission (RFC 9309
        // §2.3.1.4) — `fetchRobots` owns that ruling and this pass inherits it.
        robots: isSameOrigin(url, opts.siteUrl)
          ? Promise.resolve(opts.originRobots)
          : (async () => {
              await gate.acquire(host);
              const info = await fetchRobots(
                new URL(url).origin,
                {
                  userAgent: opts.userAgent,
                  allowPrivate,
                  timeoutMs,
                  retryBackoffMs: opts.robotsRetryBackoffMs,
                },
                "disallow",
              );
              // Only the first attempt came through the gate; the retries are
              // `fetchRobots`' own short backoff, which is the discipline the
              // crawl origin's robots.txt already gets.
              requests += info.attempts;
              if (info.crawlDelaySec !== null) {
                // This host's own rule, on this host's queue only.
                gate.raiseHostFloor(host, info.crawlDelaySec * 1000);
              }
              return info;
            })(),
        consecutiveErrors: 0,
        parked: null,
      };
      hosts.set(host, record);
    }

    if (record.parked !== null) return { kind: "parked", reason: record.parked };

    const robots = await record.robots;
    if (!robots.isAllowed(url)) {
      return {
        kind: "denied",
        reason: robots.note ?? `robots.txt (${host}) disallows this URL`,
        outcome: robots.outcome,
      };
    }
    return { kind: "ok" };
  };

  /**
   * Tell the gate how one request ended, in the PAGE vocabulary — the gate's
   * escalation rules are written in it, and a resource's 429 is the same
   * statement about the same host as a page's.
   */
  const reportToGate = (host: string, url: string, attempt: Attempt): void => {
    if (attempt.kind === "refused") return;
    if (attempt.kind === "error") {
      gate.report(host, {
        fetchClass: attempt.fetchClass,
        statusCode: null,
        retryAfterMs: null,
        url,
      });
      return;
    }
    const fetchClass = classifyStatus(attempt.statusCode, attempt.headers, "");
    const throttled =
      fetchClass === "blocked" ||
      (fetchClass === "server_error" && attempt.statusCode === 503);
    gate.report(host, {
      fetchClass,
      statusCode: attempt.statusCode,
      retryAfterMs: throttled
        ? parseRetryAfter(headerValue(attempt.headers, "retry-after")).ms
        : null,
      url,
    });
  };

  /** Fetch one row's URL, following what it says to follow. */
  const processOne = async (item: WorkItem): Promise<void> => {
    const started = Date.now();
    let url = item.url;
    let method: "HEAD" | "GET" = "HEAD";
    let hops = 0;
    let spent = 0;
    let redirectedTo: string | null = null;

    const done = (verdict: Verdict): Promise<void> =>
      writeVerdict(db, crawlId, item.url, {
        ...verdict,
        fetchMs: verdict.fetchClass === null ? null : Date.now() - started,
      });

    /**
     * The row's reason: what happened, and — when the chain moved — where it
     * ended up. Built by joining the parts that exist rather than by
     * concatenation, because most of the time one of them is empty: an `ok` row
     * after a redirect has only the second half, and an `ok` row with no
     * redirect has neither and takes a null reason.
     */
    const note = (reason: string): string =>
      [
        reason,
        redirectedTo === null
          ? ""
          : `followed ${hops} redirect${hops === 1 ? "" : "s"} to ${redirectedTo}`,
      ]
        .filter((part) => part !== "")
        .join("; ");

    for (;;) {
      // The caller's stop, honoured per REQUEST rather than per batch. At a 30s
      // spacing a batch of 200 is well over an hour, and "we stopped asking"
      // has to mean the next request, not the next batch (hard rule 7). The row
      // is left exactly as it was: null, no reason, nothing decided.
      if (opts.signal?.aborted === true) return;

      if (spent >= MAX_ROW_REQUESTS) {
        failed += 1;
        return done(
          unfetchable("fetch_error", note(`spent its ${MAX_ROW_REQUESTS}-request budget`)),
        );
      }

      // Hard rule 5, on every hop and not only on the first: a Location is
      // attacker-controlled text, and `resources.url` was never vetted at all.
      const verdict = await isUrlAllowed(url, { allowPrivate });
      if (!verdict.allowed) {
        failed += 1;
        return done(unfetchable("refused", note(verdict.reason ?? "refused by the URL policy")));
      }
      const host = new URL(url).host;

      const admission = await admit(host, url);
      if (admission.kind === "capped") {
        // Unfetched, not failed: the null still means "seen, not yet asked".
        return done(unfetchable(null, RESOURCE_CAP_REASON));
      }
      if (admission.kind === "parked") {
        failed += 1;
        return done(unfetchable("fetch_error", note(admission.reason)));
      }
      if (admission.kind === "denied") {
        failed += 1;
        // WHICH refusal, off the closed vocabulary rather than off the
        // sentence. `unreachable` is still a complete disallow (RFC 9309
        // §2.3.1.4) — no request is made on either branch — but a reader
        // counting "hosts that forbid us" must not be counting hosts that were
        // down. See the class list at the top of this file, and
        // docs/gates/phase-11.md §10.2 for why prose-matching was refused.
        return done(
          unfetchable(
            admission.outcome === "unreachable"
              ? RESOURCE_ROBOTS_UNREACHABLE_CLASS
              : RESOURCE_ROBOTS_DENIED_CLASS,
            note(admission.reason),
          ),
        );
      }

      await gate.acquire(host);
      // Re-checked after the wait: a sibling worker may have parked this host
      // while we sat in its queue, and asking anyway would be three more
      // requests at a server that has already stopped answering.
      const record = hosts.get(host);
      if (record !== undefined && record.parked !== null) {
        failed += 1;
        return done(unfetchable("fetch_error", note(record.parked)));
      }

      const attempt = await requestResource(url, method, {
        userAgent: opts.userAgent,
        allowPrivate,
        timeoutMs,
        count: method === "GET",
        maxCountedBytes,
      });
      spent += 1;
      requests += 1;
      reportToGate(host, url, attempt);

      if (attempt.kind === "refused") {
        // The connect-time address guard, which is the wall the string-level
        // policy above cannot be: a public name with a private A record.
        failed += 1;
        return done(unfetchable("refused", note(attempt.reason)));
      }
      if (attempt.kind === "error") {
        if (record !== undefined) {
          record.consecutiveErrors += 1;
          if (record.consecutiveErrors >= DEAD_HOST_ERRORS && record.parked === null) {
            record.parked =
              `host parked after ${DEAD_HOST_ERRORS} consecutive fetch errors ` +
              `(${attempt.reason})`;
          }
        }
        failed += 1;
        return done(unfetchable("fetch_error", note(attempt.reason)));
      }
      if (record !== undefined) record.consecutiveErrors = 0;

      const status = attempt.statusCode;
      const headers = attempt.headers;

      if (status >= 300 && status < 400) {
        const location = headerValue(headers, "location");
        if (location === null) {
          failed += 1;
          return done(unfetchable("fetch_error", note(`HTTP ${status} without a Location header`)));
        }
        let resolved: string;
        try {
          // The Location as resolved, NOT normalised: a signed CDN URL's query
          // order is the server's business, and `normalizeUrl` sorts it. The
          // row keeps its own identity; only what we ask for moves.
          resolved = new URL(location, url).href;
        } catch {
          failed += 1;
          return done(
            unfetchable("fetch_error", note(`unresolvable Location header (${location})`)),
          );
        }
        hops += 1;
        if (hops > MAX_RESOURCE_REDIRECTS) {
          failed += 1;
          return done(
            unfetchable("fetch_error", note(`more than ${MAX_RESOURCE_REDIRECTS} redirects`)),
          );
        }
        url = resolved;
        redirectedTo = resolved;
        method = "HEAD";
        continue;
      }

      // The two answers that mean "not by HEAD": a server that refuses the
      // method outright. One GET, and only one — `spent` bounds the rest.
      if (method === "HEAD" && (status === 405 || status === 501)) {
        method = "GET";
        continue;
      }

      const fetchClass = classifyStatus(status, headers, "");
      const cacheControl = headerValue(headers, "cache-control");
      const expires = headerValue(headers, "expires");
      const contentType = headerValue(headers, "content-type");

      if (fetchClass !== "ok") {
        failed += 1;
        // A block is a status here and a rate statement to the gate. The row
        // says which status it was and, when it was a refusal rather than a
        // plain 404, why the class reads the way it does.
        const reason =
          fetchClass === "blocked" ? note(`refused by the server (HTTP ${status})`) : note("");
        return done({
          fetchClass: status >= 500 ? "server_error" : "client_error",
          fetchReason: reason === "" ? null : reason,
          statusCode: status,
          contentType,
          bytes: null,
          bytesSource: null,
          cacheControl,
          expires,
          fetchMs: null,
        });
      }

      const declared = contentLength(headers);
      if (method === "HEAD" && declared === null) {
        // The server cannot say how big it is, so we measure it: one GET,
        // streamed into a counter and discarded (hard rule 6).
        method = "GET";
        continue;
      }

      const counted = attempt.counted;
      const bytes = counted ?? declared;
      if (bytes === null) {
        // A GET that neither counted nor declared is this module's bug.
        throw new Error(
          `fetchCrawlResources: ${url} answered ${status} with no counted or declared size`,
        );
      }
      fetched += 1;
      const truncatedNote = attempt.countTruncated
        ? `body exceeded the ${maxCountedBytes}-byte counting cap; bytes is a floor`
        : "";
      const reason = note(truncatedNote);
      return done({
        fetchClass: "ok",
        fetchReason: reason === "" ? null : reason,
        statusCode: status,
        contentType,
        // A counted body is a measurement and a `content-length` is a claim;
        // when we have both we keep the measurement, and the column says which
        // it was so a weight number can be read for what it is.
        //
        // A HEAD that LIES about `content-length` — a real thing on badly
        // configured origins — is therefore believed, and deliberately: the only
        // way to catch it is to GET every file and compare, which doubles the
        // requests this crawl makes at somebody's server to improve a number
        // nobody has yet asked to be exact (rule 9). `bytes_source: 'header'`
        // is what keeps that legible: the row does not claim to have measured.
        bytes,
        bytesSource: counted === null ? "header" : "counted",
        cacheControl,
        expires,
        fetchMs: null,
      });
    }
  };

  // ---- the work list, cursor-paged so nothing accumulates (hard rule 6) ----
  let cursor: string | null = null;
  for (;;) {
    // The batch-level check. `processOne` makes the same one before every
    // request, so this is the outer loop noticing what a worker already acted
    // on rather than the first place a stop is honoured.
    if (opts.signal?.aborted === true) break;
    const batch = await workList(db, crawlId, cursor, WORK_BATCH);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.url;

    // The budget is claimed for the whole slice before any of it is fetched, so
    // the cap is exact however the workers interleave.
    let slice = batch;
    if (budget < batch.length) {
      slice = batch.slice(0, budget);
      cappedByResources = true;
    }
    budget -= slice.length;

    const failures = await runPool(slice, opts.maxConcurrency, processOne);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `resource pass: ${failures.length} rows of crawl ${crawlId} threw`,
      );
    }
    if (cappedByResources) break;
  }

  // Read once, at the end, and returned: the signal may have fired inside a
  // worker (which stops asking immediately) rather than at a batch boundary,
  // and the caller has to be able to tell "the pass finished" from "the pass was
  // stopped" — the crawl loop closes its row `cancelled` on this (hard rule 7).
  const aborted = opts.signal?.aborted === true;

  if (cappedByResources && !aborted) {
    // Loud, not silent: every row the cap stopped short of says so, in one
    // statement rather than one per row. An ABORT deliberately marks nothing —
    // those rows were not capped, they were interrupted, nothing was decided
    // about them, and their null already means "seen, not yet asked".
    //
    // `&& !aborted` IS WHAT MAKES THAT SENTENCE TRUE (P12-T2, review C-1). The
    // budget is claimed for a whole slice before any of it is asked about, so
    // the two stops overlap: `cappedByResources` goes true at the top of a batch
    // and the caller's signal can fire inside that same batch. Without the guard
    // this statement then stamped `resource-cap` over rows an abort had left —
    // contradicting the comment above it and the module header at once, and, on
    // a small enough budget, producing a whole census of `resource-cap` rows
    // with nothing decided at all. A stop the CALLER made is not a budget
    // running out, and only the caller's row shape can say which happened.
    await db
      .update(resources)
      .set({ fetchReason: RESOURCE_CAP_REASON })
      .where(
        and(
          eq(resources.crawlId, crawlId),
          isNull(resources.fetchClass),
          isNull(resources.fetchReason),
        ),
      );
  }

  return {
    seen: await countRows(db, crawlId, false),
    fetched,
    failed,
    // Rows still unfetched, whatever left them so — a cap, or this abort. The
    // two are told apart by the flags beside it and by the rows themselves:
    // a capped row carries a reason, an interrupted one carries nothing.
    skipped: await countRows(db, crawlId, true),
    hosts: hosts.size,
    requests,
    cappedByResources,
    cappedByHosts,
    aborted,
  };
}

/**
 * Write the operator's decision onto every row this crawl will not ask about —
 * what runs INSTEAD of the pass when `CrawlConfig.fetchResources` is false.
 *
 * One statement, and it touches only rows nothing has decided anything about:
 * `fetch_class is null and fetch_reason is null`. That makes it idempotent (a
 * resume re-stamps nothing) and keeps it off a row a cap already claimed — a
 * shape that cannot arise today, since a crawl configured with the pass off
 * never ran one, and asserted by the predicate rather than by that argument.
 *
 * RETURNS NOTHING, and that is the same ruling the surfaces make one layer up:
 * the number a reader wants is "how many files this crawl has not asked about",
 * which is `crawl_status.resources.skipped`, counted off the table at read time.
 * A count returned from here could only reach a caller through
 * `CrawlSummary.resources` — which is null on a crawl that ran no pass, by
 * design — so it would be a value nobody reads, and an unread value rots (the
 * `click_depth` lesson). It also would have cost `returning()`: materialising
 * every stamped URL to take its `length`, on a statement whose whole job is to
 * touch rows without carrying them.
 */
export async function markResourcesNotAsked(db: Db, crawlId: string): Promise<void> {
  await db
    .update(resources)
    .set({ fetchReason: RESOURCE_OFF_REASON })
    .where(
      and(
        eq(resources.crawlId, crawlId),
        isNull(resources.fetchClass),
        isNull(resources.fetchReason),
      ),
    );
}

/** A verdict with nothing to report but the reason. */
function unfetchable(
  fetchClass: ResourceFetchClass | null,
  reason: string,
): Verdict {
  return {
    fetchClass,
    fetchReason: reason,
    statusCode: null,
    contentType: null,
    bytes: null,
    bytesSource: null,
    cacheControl: null,
    expires: null,
    fetchMs: null,
  };
}

/**
 * The next slice of the work list: the crawl's rows whose `fetch_class` is
 * still null, in URL order past `cursor`.
 *
 * ORDER BY url is not cosmetic. A URL sorts by scheme and host before anything
 * else, so ordering by it groups a host's files together — which is what makes
 * the host census, the robots cache and the parked-host check see a host's rows
 * as one run rather than scattered through the crawl.
 */
async function workList(
  db: Db,
  crawlId: string,
  cursor: string | null,
  limit: number,
): Promise<WorkItem[]> {
  const where =
    cursor === null
      ? and(eq(resources.crawlId, crawlId), isNull(resources.fetchClass))
      : and(
          eq(resources.crawlId, crawlId),
          isNull(resources.fetchClass),
          gt(resources.url, cursor),
        );
  return db
    .select({ url: resources.url })
    .from(resources)
    .where(where)
    .orderBy(asc(resources.url))
    .limit(limit);
}

async function countRows(db: Db, crawlId: string, unfetchedOnly: boolean): Promise<number> {
  const result = await db.execute<{ n: number }>(
    unfetchedOnly
      ? sql`select count(*)::int as n from resources
             where crawl_id = ${crawlId} and fetch_class is null`
      : sql`select count(*)::int as n from resources where crawl_id = ${crawlId}`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`fetchCrawlResources: the count for crawl '${crawlId}' returned no row`);
  }
  return row.n;
}

async function writeVerdict(
  db: Db,
  crawlId: string,
  url: string,
  verdict: Verdict,
): Promise<void> {
  await db
    .update(resources)
    .set({
      fetchClass: verdict.fetchClass,
      fetchReason: verdict.fetchReason,
      statusCode: verdict.statusCode,
      contentType: verdict.contentType,
      bytes: verdict.bytes,
      bytesSource: verdict.bytesSource,
      cacheControl: verdict.cacheControl,
      expires: verdict.expires,
      // A row nobody asked about has no time of asking. `fetched_at` and
      // `fetch_class` move together, both null or neither.
      fetchedAt: verdict.fetchClass === null ? null : new Date(),
      fetchMs: verdict.fetchMs,
    })
    .where(and(eq(resources.crawlId, crawlId), eq(resources.url, url)));
}

/**
 * Run `fn` over `items` with at most `workers` in flight, collecting what threw
 * rather than tearing the batch down mid-flight — the crawl loop's discipline,
 * for the same reason: a sibling that is mid-write must be allowed to finish
 * before the error is raised.
 */
async function runPool<T>(
  items: readonly T[],
  workers: number,
  fn: (item: T) => Promise<void>,
): Promise<unknown[]> {
  let index = 0;
  const failures: unknown[] = [];
  const runner = async (): Promise<void> => {
    for (;;) {
      const item = items[index++];
      if (item === undefined) return;
      try {
        await fn(item);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, () => runner()),
  );
  return failures;
}

function contentLength(headers: HeaderBag): number | null {
  const raw = headerValue(headers, "content-length");
  if (raw === null) return null;
  const value = Number(raw.trim());
  // A header we cannot read is not a size to guess at (hard rule 7): the pass
  // spends a GET and counts instead.
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

interface RequestOpts {
  userAgent: string;
  allowPrivate: boolean;
  timeoutMs: number;
  /** Stream the body into a counter and discard it. GET only. */
  count: boolean;
  /** The counter's ceiling. See MAX_COUNTED_BYTES. */
  maxCountedBytes: number;
}

/**
 * One request at one URL. Never throws for the server's behaviour; throws for
 * ours (`isProgrammerError`), exactly as `fetchPage` does.
 *
 * `accept-encoding: gzip` is sent because a browser sends one: what the weight
 * rules want is the bytes a visitor's connection carries, so a `content-length`
 * for the gzipped body and a count of gzipped chunks are the same measurement
 * and both are the right one. Nothing is inflated — we never look at the bytes.
 */
async function requestResource(
  url: string,
  method: "HEAD" | "GET",
  opts: RequestOpts,
): Promise<Attempt> {
  const deadline = new AbortController();
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    deadline.abort();
  }, opts.timeoutMs);

  try {
    const response = await request(url, {
      dispatcher: sharedAgent(opts.allowPrivate),
      method,
      headers: {
        "user-agent": opts.userAgent,
        accept: "*/*",
        "accept-encoding": ACCEPT_ENCODING,
      },
      // Manual redirects, like the page path: every hop is re-checked by the
      // URL policy and re-queued behind its own host's gate, which a client
      // following redirects for us would skip.
      signal: deadline.signal,
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
    });

    const headers = response.headers as HeaderBag;
    let counted: number | null = null;
    let countTruncated = false;

    if (opts.count) {
      let bytes = 0;
      for await (const chunk of response.body) {
        // The whole of what we do with a resource body: add its length and drop
        // it. Nothing is concatenated, nothing is decoded (hard rule 6).
        bytes += (chunk as Buffer).length;
        if (bytes > opts.maxCountedBytes) {
          countTruncated = true;
          response.body.destroy();
          break;
        }
      }
      counted = bytes;
    } else {
      // A HEAD has no body, but undici still hands one over and the socket does
      // not return to the pool until it is consumed.
      await response.body.dump();
    }

    return { kind: "response", statusCode: response.statusCode, headers, counted, countTruncated };
  } catch (error) {
    if (isProgrammerError(error)) throw error;
    const refusal = blockedAddressMessage(error);
    if (refusal !== null) return { kind: "refused", reason: `refused at connect: ${refusal}` };
    if (deadlineHit || isTimeout(error)) {
      return { kind: "error", reason: "timed out", fetchClass: "timeout" };
    }
    return { kind: "error", reason: describeError(error), fetchClass: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

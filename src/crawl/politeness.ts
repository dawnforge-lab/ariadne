/**
 * Politeness governor: how fast we are allowed to go, and how closely spaced
 * two hits on one host may be.
 *
 * Two independent controls, deliberately not merged:
 *
 * - `CrawlWindow` is *adaptive concurrency*. It reacts to what the site tells
 *   us — throttling, 5xx, timeouts shrink it; a clean, full, fast batch grows
 *   it by one. It also carries the in-flight byte budget, which is the OOM
 *   guard behind the memory contract (RAM O(concurrency), never O(URLs)).
 * - `HostGate` is *spacing*. Adaptive concurrency alone does not give a
 *   WAF's token bucket what it wants: yellow.com.mt blocked us at a modest
 *   concurrency because the requests arrived in bursts. A per-host minimum
 *   interval, honouring robots `crawl-delay`, is the fix. The interval has a
 *   FIXED base — max(config, robots), capped — and an ADAPTIVE layer over it:
 *   a refusal that names a rate doubles that host's spacing, a volley of
 *   refusals across several URLs eventually does the same, and a `Retry-After`
 *   header is honoured as a floor under the host's next slot (see `report`,
 *   which is where the difference between those two is argued).
 *
 * Both halves see every settled fetch, and they compose rather than duplicate:
 * a 429 shrinks the window (fewer requests at once) AND widens that host's
 * spacing (more time between them). A token bucket wants the second; a busy
 * origin wants the first; a Shopify site behind Cloudflare hands out both
 * complaints at once.
 *
 * Pure logic — no I/O, no fetching, no database. The crawl loop wires it.
 *
 * Memory: the gate holds one map keyed by host, whose value is a dozen scalars —
 * O(hosts touched), not O(URLs). A site crawl touches one host, or a handful
 * with its variants; the memory contract (rule 6) is about the frontier and the
 * page bodies, and nothing here grows with either. See `HostState` for the one
 * place that constraint shaped the design.
 */

import type { FetchClass } from "./fetch-page.js";

/** What one settled fetch tells the governor. */
export interface BatchOutcome {
  fetchClass: FetchClass;
  responseTimeMs: number;
  htmlBytes: number;
}

/**
 * What one settled fetch tells the *gate*. Deliberately not `BatchOutcome`:
 * the window judges a batch by how fast and how clean it was, the gate judges
 * one host by whether it pushed back and what it asked for. Merging them would
 * make every caller of one carry the other's fields.
 */
export interface HostOutcome {
  fetchClass: FetchClass;
  /**
   * The response's status, or null when there was no response to read one from.
   * It decides WHICH of the two escalations a refusal gets — see `report`.
   */
  statusCode: number | null;
  /**
   * `Retry-After`, in milliseconds from now. Null when the response carried
   * none, or carried one we could not read — an unreadable header is recorded
   * in the page row by `fetch-page`'s `parseRetryAfter` and NEVER guessed at
   * here (hard rule 7). A value that arrives negative or non-finite is our own
   * parser's bug and is thrown, not clamped.
   */
  retryAfterMs: number | null;
  /**
   * The URL this outcome belongs to. The streak rule needs it: a volley of
   * 403s from one URL's own retries says nothing about the host, and a volley
   * spanning several URLs says everything (see `report`).
   */
  url: string;
}

/**
 * Classes that mean "the server is pushing back". `client_error`, `non_html`,
 * `too_large`, `redirect`, `unsupported_encoding` and `disallowed` are the
 * site's own business — a wall of 404s is not a throttling signal and must not
 * collapse the window, and neither is a CDN that answers `br` to every request
 * however slowly we make them. `network_error` is deliberately excluded too:
 * it is usually one bad host or a DNS hiccup, not us being too fast (a real
 * block arrives as `blocked`).
 */
const BACKPRESSURE: ReadonlySet<FetchClass> = new Set<FetchClass>([
  "blocked",
  "server_error",
  "timeout",
]);

const DEFAULT_INITIAL_WINDOW = 4;
const DEFAULT_SLOW_MS = 1500;
const DEFAULT_BYTE_BUDGET = 64 * 1024 * 1024;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * The spacing a block escalates FROM when the crawl was configured with no
 * per-host delay at all and robots.txt asked for none either.
 *
 * Doubling zero is zero, so a base of 0 would make the ratchet a silent no-op —
 * in exactly the configuration where a 429 matters most. 500ms seeds it, so the
 * first block spaces that host at 1s, the second at 2s, and so on. Any positive
 * base doubles itself and never sees this number.
 */
const ZERO_BASE_SEED_MS = 500;

/**
 * How many consecutive pushback responses a host must give, across at least two
 * DIFFERENT URLs, before a refusal that named no rate (a 401, a 403, a bare
 * 503, a challenge page) is treated as being about the crawl rather than about
 * the URL. See `report`.
 */
const ESCALATION_STREAK = 3;

/**
 * How many consecutive CLEAN responses a host must give since its last
 * escalation before it is stepped down one escalation level (its spacing
 * halves, never below its base). See "The ratchet" in `report`.
 *
 * Clean means a 2xx, 3xx or 4xx other than 429, carrying no `Retry-After`. 50
 * is ours, not Screaming Frog's (SF uses a fixed rate and no adaptive back-off
 * at all); it is test-pinned and calibrated at the Phase 24a gate.
 */
export const RECOVERY_STREAK = 50;

/**
 * What one host did to the crawl's pace, for the operator: crawl EVIDENCE, not a
 * finding (the Phase 16 owner ruling — how the site received the crawl is not a
 * site issue). `HostGate.throttleRecord()`.
 */
export interface HostThrottle {
  /** Responses with status 429. */
  responses429: number;
  /** Responses that carried a readable `Retry-After`, on any status. */
  retryAfterSeen: number;
  /**
   * How many times this host's answers escalated the spacing, over the whole
   * crawl — a CUMULATIVE count, never decremented. The level currently in force
   * is `escalations - recoveries`.
   */
  escalations: number;
  /**
   * How many times a clean run stepped the host down one level. Any number up
   * to `escalations`: a host descends one level per `RECOVERY_STREAK` clean
   * responses until it reaches its base or escalates again (which locks it).
   */
  recoveries: number;
  /** True once the host escalated after having recovered: no further recovery. */
  recoveryLocked: boolean;
  /** The widest spacing this host was ever crawled at. */
  peakSpacingMs: number;
  /** The spacing in force for this host now. */
  finalSpacingMs: number;
}

/**
 * One host's entry in `crawls.host_spacing_jsonb` since Phase 24a —
 * `HostGate.snapshot()`, read back by `HostGate.restore()`.
 *
 * `spacingMs` is the host's current spacing (the number the pre-24a map held,
 * and `HostThrottle.finalSpacingMs`); `baseMs` and the level
 * (`escalations - recoveries`) are what let a resumed host keep its place on
 * the ratchet, so it can still recover and a second strike still locks it. The
 * counters are `HostThrottle`'s, so the record survives a resume too.
 */
export interface HostSpacingEntry {
  spacingMs: number;
  baseMs: number;
  responses429: number;
  retryAfterSeen: number;
  /** Cumulative, as `HostThrottle.escalations`. */
  escalations: number;
  recoveries: number;
  recoveryLocked: boolean;
  peakSpacingMs: number;
}

/**
 * What `crawls.host_spacing_jsonb` may hold: the pre-24a `{host: ms}` map
 * (migration 0015 to Phase 23), or the 24a `{host: HostSpacingEntry}` map.
 * Typed as a per-entry union because that is what a reader must handle; the
 * gate's `restore()` refuses a map that actually mixes the two.
 */
export type StoredHostSpacing = Record<string, number | HostSpacingEntry>;

export interface CrawlWindowOptions {
  /** Starting concurrency. Default 4. Must be ≥ 1 and ≤ max. */
  initial?: number;
  /** Ceiling the window may never grow past. */
  max: number;
  /** p95 response time at or above which the window stops growing. Default 1500. */
  slowMs?: number;
  /** In-flight bytes allowed at once. Default 64MiB. */
  byteBudget?: number;
}

/**
 * Nearest-rank p95: sorted[ceil(0.95 * n) - 1]. For small batches that is the
 * slowest sample, which is what we want — one 3s response in a batch of five
 * is exactly the signal that says "do not push harder".
 */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

export class CrawlWindow {
  private current: number;
  private readonly max: number;
  private readonly slowMs: number;
  private readonly byteBudget: number;
  private inFlightBytes = 0;

  constructor(opts: CrawlWindowOptions) {
    const initial = opts.initial ?? DEFAULT_INITIAL_WINDOW;
    const slowMs = opts.slowMs ?? DEFAULT_SLOW_MS;
    const byteBudget = opts.byteBudget ?? DEFAULT_BYTE_BUDGET;

    if (!Number.isInteger(opts.max) || opts.max < 1) {
      throw new RangeError(`CrawlWindow: max must be an integer ≥ 1, got ${opts.max}`);
    }
    if (!Number.isInteger(initial) || initial < 1) {
      throw new RangeError(`CrawlWindow: initial must be an integer ≥ 1, got ${initial}`);
    }
    if (initial > opts.max) {
      throw new RangeError(`CrawlWindow: initial ${initial} exceeds max ${opts.max}`);
    }
    if (!(slowMs > 0)) {
      throw new RangeError(`CrawlWindow: slowMs must be > 0, got ${slowMs}`);
    }
    if (!(byteBudget > 0)) {
      throw new RangeError(`CrawlWindow: byteBudget must be > 0, got ${byteBudget}`);
    }

    this.current = initial;
    this.max = opts.max;
    this.slowMs = slowMs;
    this.byteBudget = byteBudget;
  }

  /** Concurrent fetches the loop may have in flight right now. */
  size(): number {
    return this.current;
  }

  /**
   * Adapt to a settled batch.
   *
   * Shrink beats grow: any back-pressure class halves the window (floored, min
   * 1) regardless of how fast the rest of the batch was. Growth needs all
   * three of: no back-pressure, a *full* batch (a partial batch says nothing
   * about headroom — we never learned whether the extra slot would have been
   * served), and p95 under `slowMs`.
   */
  onBatchSettled(outcomes: readonly BatchOutcome[]): void {
    if (outcomes.length === 0) return;

    if (outcomes.some((o) => BACKPRESSURE.has(o.fetchClass))) {
      this.current = Math.max(1, Math.floor(this.current / 2));
      return;
    }

    const full = outcomes.length >= this.current;
    const fast = p95(outcomes.map((o) => o.responseTimeMs)) < this.slowMs;
    if (full && fast) this.current = Math.min(this.max, this.current + 1);
  }

  /**
   * Reserve `bytes` of the in-flight budget. False means the caller must wait
   * and try again — this is the back-pressure that keeps peak RSS bounded.
   *
   * A request is always admitted when nothing else is in flight, even if it
   * alone exceeds the budget: refusing it would deadlock the loop with no
   * outstanding release to unblock it. In practice fetch-page caps bodies at
   * 2MiB (`MAX_BODY`) against a 64MiB default budget, so that branch is a guard, not a
   * routine path.
   */
  admitBytes(bytes: number): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(`CrawlWindow.admitBytes: bytes must be ≥ 0, got ${bytes}`);
    }
    if (this.inFlightBytes > 0 && this.inFlightBytes + bytes > this.byteBudget) {
      return false;
    }
    this.inFlightBytes += bytes;
    return true;
  }

  /** Return a reservation. Releasing more than was admitted is a caller bug. */
  releaseBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(`CrawlWindow.releaseBytes: bytes must be ≥ 0, got ${bytes}`);
    }
    if (bytes > this.inFlightBytes) {
      throw new RangeError(
        `CrawlWindow.releaseBytes: released ${bytes} with only ${this.inFlightBytes} in flight`,
      );
    }
    this.inFlightBytes -= bytes;
  }
}

export interface HostGateOptions {
  /** Our own configured minimum spacing between two hits on one host. */
  perHostDelayMs: number;
  /** robots.txt `Crawl-delay`, in seconds; null when the site declares none. */
  robotsCrawlDelaySec: number | null;
  /** Upper bound on the honoured delay. Default 30s. */
  maxDelayMs?: number;
  /**
   * The widest spacing an EARLIER RUN OF THIS CRAWL already earned —
   * `crawls.host_spacing_ms` — or null/absent for a crawl that has none.
   *
   * It joins `perHostDelayMs` and the robots `Crawl-delay` in the same max, and
   * it is here rather than at a call site because this module owns spacing (see
   * `raiseHostFloor`: one policy, one place). The three inputs say three
   * different things and the widest of them wins: what we configured, what the
   * site asked for in writing, and what the site taught us by refusing us.
   *
   * WHY A RESUME MUST CARRY IT. When the column is above the crawl's base it is
   * a FINDING rather than a setting — a host refused us and the engine backed
   * off (rule 9) — and a second run over the same crawl id is the same crawler
   * talking to the same host. Rebuilding the gate from the configured floor
   * alone would hit that host at the pace it already refused, and the loop's
   * first `recordSpacing` would write the floor back over the evidence, so
   * nobody could see it had happened. This is exactly the ruling `renderPaceMs`
   * makes for the render pass (docs/gates/phase-6.md §c1633c4), applied to the
   * pass that earned it.
   *
   * `max`, not "replace": a caller who deliberately asks for a wider delay than
   * the crawl earned keeps it, and the cap binds it like everything else.
   *
   * ## Two things this is NOT, both of which a reader will otherwise assume
   *
   * **IT IS THE CRAWL-WIDE FALLBACK, NOT THE PER-HOST TRUTH.**
   * `crawls.host_spacing_ms` is one number for the whole crawl — the WIDEST
   * spacing any host reached (`maxSpacingMs`) — so re-entering it here applies
   * that width to EVERY host the resumed run touches, including hosts that never
   * pushed back. On a crawl whose CDN earned 8s while the origin stayed at 1s,
   * this number alone would crawl the origin at 8s too. That is the polite
   * direction, so it is not worked around; it is the FALLBACK. The per-host
   * truth lives beside it in `crawls.host_spacing_jsonb` ({host: earnedMs},
   * migration 0015), which `earnedSpacingByHost` carries: a host in that map
   * re-enters ITS OWN earned spacing, and only a host the map does not name
   * (a URL discovered on the continuation, or a pre-0015 row whose map is null)
   * falls back to this crawl-wide number, then to the config floor. So the CDN
   * resumes at 8s and the origin at 1s. `maxDelayMs` still bounds both, so the
   * worst case is the 30s cap and never more.
   *
   * **THE COLUMN IS NOT ONLY EARNED.** The loop writes `maxSpacingMs()` once
   * before the first fetch, so a crawl that never escalated still stores
   * `max(perHostDelayMs, robots Crawl-delay)` — an unearned base wearing the
   * same column. Two consequences, both real and neither hidden: a robots.txt
   * `Crawl-delay` the site has SINCE REMOVED stays sticky across every resume of
   * that crawl (the gate would read the new robots.txt and get nothing, but the
   * old number is still in the column); and a resume can never LOWER a crawl's
   * spacing by changing its config, because this max only ever raises. Both are
   * the safe direction — the failure mode is being too polite to a site that no
   * longer asks for it — and a caller who genuinely needs the lower pace starts
   * a new crawl, which has no column to read.
   */
  earnedSpacingMs?: number | null;
  /**
   * The PER-HOST spacing an earlier run of this crawl earned —
   * `crawls.host_spacing_jsonb`, `{host: earnedMs}` — or null/absent for a crawl
   * that has none (a fresh crawl, or a pre-0015 row that kept only the crawl-wide
   * `earnedSpacingMs`).
   *
   * This is the fidelity `earnedSpacingMs` on its own cannot give (see its "IT IS
   * THE CRAWL-WIDE FALLBACK" note): the crawl-wide number is the widest ANY host
   * reached, so re-entering it alone widens every host to the worst host's
   * spacing. A host named here re-enters ITS OWN earned number instead — folded
   * into the same max as everything else, `max(config, robots, thisHostEarned)`
   * capped at `maxDelayMs`, so the config floor, a robots `Crawl-delay` and the
   * 30s cap all still win where they won. A host NOT named here keeps the
   * crawl-wide fallback (`this.delayMs`), which is the polite direction for a
   * host nobody has a per-host reading of yet.
   *
   * A host's earned value is always ≤ the crawl-wide widest (the widest is the
   * max over hosts), so seeding it never exceeds `this.delayMs` and the lease
   * high-water is unaffected. A value that is negative or non-finite is a defect
   * in what wrote the column, and it throws rather than being clamped (hard rule
   * 7), exactly as `earnedSpacingMs` does.
   *
   * This is the pre-24a spelling of `restore()` with a legacy map, and it runs
   * through `restore()`. The crawl loop calls `restore()` directly, because since
   * Phase 24a the column may hold the richer per-host state.
   */
  earnedSpacingByHost?: Record<string, number> | null;
}

/**
 * What the gate remembers about one host. Fixed size — scalars only, no
 * collections — because the alternative (the set of URLs in the current streak)
 * would be O(URLs) on a host that refuses everything, which is the one thing
 * the memory contract forbids (rule 6). Knowing whether a SECOND distinct URL
 * has appeared is all the streak rule needs, and that is one string and one
 * boolean.
 */
interface HostState {
  /** The earliest wall-clock ms at which the next hit may start. */
  nextAllowedAt: number;
  /**
   * This host's own base spacing, before the ratchet. The crawl's configured
   * spacing (`delayMs`) unless something raised it — see `raiseHostFloor`, whose
   * only caller today is the resource fetch pass carrying a THIRD-PARTY host's
   * `Crawl-delay` onto that host.
   *
   * A number rather than a second gate keyed by host: the crawl origin's
   * robots.txt is folded into `delayMs` at construction because it is known
   * before the first fetch, and an asset host's robots.txt is not known until
   * the pass reads it. Both are "this host asked for this much room", and one
   * base per host is the only spelling in which they mean the same thing.
   */
  baseMs: number;
  /**
   * The escalation LEVEL in force: the spacing is base × 2^escalations. An
   * escalation increments it; each recovery (see `report`, "The ratchet")
   * decrements it, never below 0.
   */
  escalations: number;
  /** Every escalation this host ever caused, for the throttle record. Never decremented. */
  escalationsTotal: number;
  /** How many times a clean run stepped this host down a level. */
  recoveries: number;
  /** Set when the host escalates after a recovery: no recovery for the rest of the crawl. */
  recoveryLocked: boolean;
  /** Consecutive clean responses since the last escalation or non-clean response. */
  cleanStreak: number;
  /** Throttle-record counters; see `HostThrottle`. */
  responses429: number;
  retryAfterSeen: number;
  /** The widest spacing this host has been crawled at. */
  peakSpacingMs: number;
  /** Consecutive pushback responses. Reset by any other outcome. */
  streak: number;
  /** The first URL of the current streak, and whether a second one has joined. */
  streakUrl: string | null;
  streakDistinct: boolean;
}

export class HostGate {
  private readonly delayMs: number;
  /**
   * The base for a host with no earned reading of its own: max(config, robots),
   * capped, WITHOUT any earned term. `delayMs` folds the crawl-wide earned
   * spacing on top of this; a host named in `earnedSpacingByHost` folds ITS OWN
   * earned spacing on top of this instead. Kept separately so a per-host seed
   * does not inherit the crawl-wide widest through `delayMs` — which is the
   * whole point of the per-host map.
   */
  private readonly configuredFloorMs: number;
  private readonly maxDelayMs: number;
  /** host → everything the gate remembers about it. O(hosts touched). */
  private readonly hosts = new Map<string, HostState>();
  /** The widest spacing any host has reached. Read by the loop's lease sizing. */
  private highWaterMs: number;
  /**
   * Bumped every time ANY host's spacing changes — an escalation, a recovery,
   * or a `raiseHostFloor` that actually moved a base. The loop watches it to
   * persist the per-host state (`snapshot()`) whenever a host moves, not only
   * when the crawl-wide widest does: a non-widest host that escalates from a value it
   * was resumed at would otherwise never be re-written, and a hard kill before
   * the close write would leave a resume re-entering that host BELOW what it
   * earned — faster than the site allowed, a rule-9 hole (P13-T3 fix round 1).
   * A plain counter, not the widest: seeding at construction does not bump it
   * (the loop writes the seeded map once up front regardless), and a `Retry-After`
   * push that moves only `nextAllowedAt` does not either — it changes no host's
   * earned spacing, which is all the map records.
   */
  private spacingGen = 0;

  constructor(opts: HostGateOptions) {
    const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    if (!(opts.perHostDelayMs >= 0) || !Number.isFinite(opts.perHostDelayMs)) {
      throw new RangeError(
        `HostGate: perHostDelayMs must be ≥ 0, got ${opts.perHostDelayMs}`,
      );
    }
    if (
      opts.robotsCrawlDelaySec !== null &&
      (!(opts.robotsCrawlDelaySec >= 0) || !Number.isFinite(opts.robotsCrawlDelaySec))
    ) {
      throw new RangeError(
        `HostGate: robotsCrawlDelaySec must be ≥ 0 or null, got ${opts.robotsCrawlDelaySec}`,
      );
    }
    if (
      opts.earnedSpacingMs !== null &&
      opts.earnedSpacingMs !== undefined &&
      (!(opts.earnedSpacingMs >= 0) || !Number.isFinite(opts.earnedSpacingMs))
    ) {
      throw new RangeError(
        `HostGate: earnedSpacingMs must be ≥ 0 or null, got ${opts.earnedSpacingMs}`,
      );
    }
    if (!(maxDelayMs > 0)) {
      throw new RangeError(`HostGate: maxDelayMs must be > 0, got ${maxDelayMs}`);
    }

    // A site asking for a full minute between hits gets 30s: past the cap the
    // crawl stops being a crawl. Below it, the site's number always wins — and
    // so does the spacing an earlier run of this crawl earned from it.
    //
    // The floor (config + robots) is computed on its own because a per-host seed
    // folds its OWN earned spacing onto it, not onto `delayMs` — which carries
    // the crawl-wide widest and would drag every seeded host up to it.
    this.maxDelayMs = maxDelayMs;
    this.configuredFloorMs = Math.min(
      maxDelayMs,
      Math.max(opts.perHostDelayMs, (opts.robotsCrawlDelaySec ?? 0) * 1000),
    );
    this.delayMs = Math.min(
      maxDelayMs,
      Math.max(this.configuredFloorMs, opts.earnedSpacingMs ?? 0),
    );
    this.highWaterMs = this.delayMs;

    // Seed the per-host earned spacings a resume carries back in (the legacy
    // map spelling; see `restore`), so each host re-enters ITS OWN number rather
    // than the crawl-wide `delayMs`.
    if (opts.earnedSpacingByHost !== null && opts.earnedSpacingByHost !== undefined) {
      this.restore(opts.earnedSpacingByHost);
    }
  }

  /**
   * Re-enter the per-host state an earlier run of this crawl persisted in
   * `crawls.host_spacing_jsonb`. Called once, on a fresh gate, before the first
   * fetch; restoring over a gate that has already seen a host throws, because
   * the two states cannot both be the truth.
   *
   * Two shapes are accepted, and nothing else (hard rule 7):
   *
   *  - **The pre-24a `{host: ms}` map** (migration 0015 to Phase 23). The number
   *    is the spacing the host had reached, with no record of how it got there,
   *    so it re-enters as the host's BASE — `max(config, robots, earned)`, capped
   *    — at level 0. There is nothing to recover from, so the earned spacing
   *    binds for the rest of the crawl, exactly as it did before 24a: the polite
   *    reading of a number whose history was not kept.
   *  - **The 24a `{host: HostSpacingEntry}` map** (`snapshot()`). The host
   *    re-enters at base `max(config, robots, baseMs)`, capped, at level
   *    `escalations - recoveries`, with its counters, its recovery count and its
   *    lock. So an unlocked resumed host can keep descending, and a host that
   *    already recovered still locks on its next escalation: a resume is not a
   *    way round the two-strike rule. The clean streak and the pushback streak are NOT
   *    carried: a resume starts both from nothing, which is the slower direction.
   *    `spacingMs` is not read back — it is derived from base and level — and is
   *    stored for readers of the column (it is the number the old map held).
   *
   * A mixed map, a non-object, an array, null, a negative or non-finite number,
   * a missing or mistyped field, more recoveries than escalations (impossible:
   * every recovery undoes an escalation), or a lock with no recovery behind it
   * (impossible: only an escalation after a recovery locks) is a column we cannot read a politeness
   * fact out of, and it throws rather than quietly forgetting a host's earned
   * spacing — which would walk the resume back into the pace that host refused
   * (rules 7 and 9). A NULL column means "no map" and is the caller's to handle:
   * this method is only for a map that is there.
   *
   * O(hosts the prior run touched), the order the gate already holds (rule 6).
   */
  restore(state: unknown): void {
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new TypeError(
        `HostGate.restore: host_spacing_jsonb must be a {host: …} object, got ${
          Array.isArray(state) ? "an array" : state === null ? "null" : typeof state
        }`,
      );
    }
    if (this.hosts.size > 0) {
      throw new Error(
        "HostGate.restore: the gate has already seen a host; restore runs once, before the first fetch",
      );
    }
    const entries = Object.entries(state as Record<string, unknown>);
    const legacy = entries.filter(([, v]) => typeof v !== "object" || v === null).length;
    if (legacy !== 0 && legacy !== entries.length) {
      throw new TypeError(
        "HostGate.restore: host_spacing_jsonb mixes the pre-24a {host: ms} shape with the 24a {host: {…}} shape",
      );
    }

    for (const [host, value] of entries) {
      if (legacy !== 0) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new RangeError(
            `HostGate.restore: host_spacing_jsonb[${host}] must be a number of ms ≥ 0, got ${String(value)}`,
          );
        }
        const base = this.foldBase(value);
        this.hosts.set(host, this.freshState(base));
        this.highWaterMs = Math.max(this.highWaterMs, base);
        continue;
      }

      const e = parseEntry(host, value as Record<string, unknown>);
      const restored: HostState = {
        ...this.freshState(this.foldBase(e.baseMs)),
        escalations: e.escalations - e.recoveries,
        escalationsTotal: e.escalations,
        recoveries: e.recoveries,
        recoveryLocked: e.recoveryLocked,
        responses429: e.responses429,
        retryAfterSeen: e.retryAfterSeen,
      };
      this.hosts.set(host, restored);
      restored.peakSpacingMs = Math.max(
        this.spacingMs(host),
        Math.min(this.maxDelayMs, e.peakSpacingMs),
      );
      this.highWaterMs = Math.max(this.highWaterMs, restored.peakSpacingMs);
    }
  }

  /**
   * Every touched host's full per-host state, for `crawls.host_spacing_jsonb`:
   * exactly what `restore()` reads back. Written by the loop beside
   * `maxSpacingMs()`. O(hosts touched); `{}` until the first host is seen.
   */
  snapshot(): Record<string, HostSpacingEntry> {
    const out: Record<string, HostSpacingEntry> = {};
    for (const [host, s] of this.hosts) {
      out[host] = {
        spacingMs: this.spacingMs(host),
        baseMs: s.baseMs,
        responses429: s.responses429,
        retryAfterSeen: s.retryAfterSeen,
        escalations: s.escalationsTotal,
        recoveries: s.recoveries,
        recoveryLocked: s.recoveryLocked,
        peakSpacingMs: s.peakSpacingMs,
      };
    }
    return out;
  }

  /**
   * What each touched host did to the crawl's pace — crawl evidence, not a
   * finding (see `HostThrottle`). Every host the gate has touched is in it,
   * including the ones that never pushed back (all counters zero); a reader that
   * wants only the hosts that throttled us filters on the counters.
   */
  throttleRecord(): Record<string, HostThrottle> {
    const out: Record<string, HostThrottle> = {};
    for (const [host, s] of this.hosts) {
      out[host] = {
        responses429: s.responses429,
        retryAfterSeen: s.retryAfterSeen,
        escalations: s.escalationsTotal,
        recoveries: s.recoveries,
        recoveryLocked: s.recoveryLocked,
        peakSpacingMs: s.peakSpacingMs,
        finalSpacingMs: this.spacingMs(host),
      };
    }
    return out;
  }

  /**
   * The spacing this gate was BUILT with: max(config, robots, earned), capped.
   * A fact about how the run was set up, not about how it is going — it never
   * moves. `earned` is in it because a resumed crawl is set up with what an
   * earlier run of it learned (see `earnedSpacingMs`); for a fresh crawl the
   * term is absent and this is max(config, robots) exactly as it always was.
   * For what a host is actually being crawled at right now, see `spacingMs`.
   */
  effectiveDelayMs(): number {
    return this.delayMs;
  }

  /**
   * The spacing in force for `host` right now: that host's base, times the
   * ratchet. The base is the crawl's configured spacing unless `raiseHostFloor`
   * has moved it for this host.
   */
  spacingMs(host: string): number {
    const state = this.hosts.get(host);
    const base = state?.baseMs ?? this.delayMs;
    const escalations = state?.escalations ?? 0;
    if (escalations === 0) return base;
    const seed = base > 0 ? base : ZERO_BASE_SEED_MS;
    return Math.min(this.maxDelayMs, seed * 2 ** escalations);
  }

  /**
   * Raise ONE host's base spacing — never lower it, never touch another host's.
   *
   * The case this exists for is a host whose own robots.txt we read after the
   * gate was built: a third-party asset host, whose `Crawl-delay` is a rule
   * about that host and about nothing else (see the resource fetch pass). The
   * crawl's configured spacing is the floor and `maxDelayMs` the ceiling, which
   * is the same arithmetic the constructor applies to the origin's own
   * `Crawl-delay` — one policy, in the one module that owns spacing.
   *
   * Idempotent and monotonic: calling it twice, or with a smaller number than
   * the host already has, changes nothing. Raising the base does not pull an
   * already-claimed slot in either — the next ACQUISITION is what it binds,
   * exactly as an escalation does.
   */
  raiseHostFloor(host: string, delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError(`HostGate.raiseHostFloor: delayMs must be ≥ 0, got ${delayMs}`);
    }
    const state = this.stateFor(host);
    const raised = Math.min(this.maxDelayMs, Math.max(state.baseMs, delayMs));
    if (raised === state.baseMs) return;
    state.baseMs = raised;
    this.spacingGen += 1;
    // A lease is sized against the widest spacing in force (see the loop's
    // leaseSecondsFor), so a base that moved has to move this too.
    const spacing = this.spacingMs(host);
    state.peakSpacingMs = Math.max(state.peakSpacingMs, spacing);
    this.highWaterMs = Math.max(this.highWaterMs, spacing);
  }

  /**
   * The widest spacing any host has reached — a crawl-wide PEAK, which a
   * recovery does not lower. It is the number a lease has to be sized against,
   * because a batch is leased before anyone knows which host's escalated queue
   * its members will sit in (see the loop's `leaseSecondsFor`).
   */
  maxSpacingMs(): number {
    return this.highWaterMs;
  }

  /**
   * The current spacing of EVERY host the gate has touched, keyed by host —
   * `crawls.host_spacing_jsonb`, written by the loop beside `maxSpacingMs()`.
   *
   * The per-host counterpart of `maxSpacingMs`: that returns the single widest
   * number for lease sizing, this returns each host's own so a resume can
   * re-enter each at ITS earned spacing rather than at the crawl-wide widest
   * (`earnedSpacingByHost`). Since Phase 24a a host can recover, so this is
   * each host's CURRENT spacing, not its high-water (that is
   * `throttleRecord()[host].peakSpacingMs`), and the loop persists the richer
   * `snapshot()` rather than this. O(hosts touched); the map is empty until the
   * first host is seen, which is the honest "no host recorded yet".
   */
  maxSpacingMsByHost(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const host of this.hosts.keys()) out[host] = this.spacingMs(host);
    return out;
  }

  /**
   * A monotonic counter of how many times any host's earned spacing has moved
   * (an escalation, a recovery, or a `raiseHostFloor` that raised a base). The loop persists
   * the per-host map whenever this changes, so a non-widest host's escalation is
   * captured within a batch rather than only at the crawl-wide widest's next
   * move (see `spacingGen`). Not a spacing itself — a change token.
   */
  spacingGeneration(): number {
    return this.spacingGen;
  }

  /**
   * Tell the gate how one fetch of `host` ended.
   *
   * ## The escalation, and why it is two rules and not one
   *
   * A refusal can mean two completely different things, and treating them
   * alike is how a crawl either fails to back off or punishes itself for hours:
   *
   *  - **"Not at this rate"** — a 429, or any refusal that carried a
   *    `Retry-After`. The server has made a statement about our REQUEST RATE,
   *    and it is true of the host, not of the URL. Every one of these doubles
   *    that host's spacing (base ×2, ×4, ×8 …, capped at `maxDelayMs`).
   *    Per response, not per consecutive response: a site alternating 200 and
   *    429 must keep backing off rather than stalling at ×2 for ever.
   *
   *  - **"Not this URL"** — a 401, a 403, a challenge page, a bare 503 with no
   *    `Retry-After`. This says nothing about our rate. A single permanently
   *    forbidden URL — an admin path, a members' area, a broken route — would
   *    otherwise spend its three retry attempts escalating the host to ×8 and
   *    tax every remaining page of the crawl for a refusal that was never about
   *    us. So these escalate only once the host has produced
   *    `ESCALATION_STREAK` pushback responses in a row **across at least two
   *    different URLs**: the yellow.com.mt shape, where a WAF that hates the
   *    rate answers 403 to everything, is a streak; one forbidden URL's own
   *    three attempts can never be one, because they prove nothing about the
   *    host. An intervening non-pushback response resets the streak.
   *
   * Once the streak has qualified, each further pushback in it escalates again,
   * so a sustained volley keeps widening exactly as a 429 volley does.
   *
   * ## The ratchet
   *
   * Whichever rule fires, ONE success never winds the spacing back — it resets
   * the streak's progress, not the spacing already earned. A token bucket that
   * emptied once will empty again, and "we got one 200, let's speed up" is
   * precisely how a crawl oscillates in and out of a WAF's bad books for an
   * hour: the yellow.com.mt lesson, and the reason the ratchet exists.
   *
   * Until Phase 24a the spacing never wound back at all, which over-learned
   * that lesson: a store that 429s once early in a 10,000-page crawl stayed at
   * double spacing for every page after it. So there is now a bounded way
   * down, and a lock behind it:
   *
   *  - **Recovery.** Every `RECOVERY_STREAK` (50) consecutive CLEAN responses
   *    since the host's last escalation or recovery step it down one level —
   *    the spacing halves, never below the host's base (at level 0 there is
   *    nothing to give back). A host escalated three times and then served
   *    cleanly descends 8× → 4× → 2× → base over 150 clean answers.
   *    Clean is a 2xx, 3xx or a 4xx other than 429, with no `Retry-After`. A
   *    429, any `Retry-After`, a `blocked` refusal (even one that did not
   *    escalate), a bare 503 or any other 5xx, and an outcome with no status at
   *    all are not clean, and each one starts the count again from nothing.
   *  - **Two strikes.** A host that escalates AFTER having recovered is
   *    `recoveryLocked` for the rest of the crawl, and from then on the ratchet
   *    is exactly the pre-24a one: up only.
   *
   * Why it cannot oscillate more than once: the first escalation after any
   * recovery sets the lock, and a locked host never recovers. So one host's
   * spacing goes up, may then come down (one level per 50 clean answers in a
   * row), and from its next escalation on only goes up: the spacing turns from
   * descending to ascending AT MOST ONCE per host per crawl. A token bucket that
   * re-empties after we speed up gets one retry, not an oscillation. A host
   * alternating 200 and 429 never produces 50 clean answers in a row, so it
   * never recovers at all. The lock and the recovery count are persisted with
   * the spacing (`snapshot`/`restore`), so a resume is not a second try either.
   * `maxSpacingMs` — the crawl-wide peak the lease is sized on — never comes
   * down; the per-host peak is in the throttle record.
   *
   * ## The floor
   *
   * A `Retry-After` is honoured as a floor under the host's next slot, on any
   * class that carries one. It competes with the escalated spacing and the
   * longer wins; it is capped at `maxDelayMs`, because `Retry-After: 31536000`
   * is a header a hostile or misconfigured origin can send and a year-long
   * sleep is not a crawl.
   *
   * The gate is told immediately, per fetch, not per batch, because the next
   * acquirer of this host may be a sibling already running. What that reaches
   * is the next ACQUISITION, not the next request: a sibling that has already
   * come through `acquire` holds a slot computed at the old spacing, and
   * `pushSlot` never pulls a slot in. The escalation binds every slot claimed
   * from here on.
   */
  report(host: string, outcome: HostOutcome): void {
    if (
      outcome.retryAfterMs !== null &&
      (!Number.isFinite(outcome.retryAfterMs) || outcome.retryAfterMs < 0)
    ) {
      // Not a site problem: fetch-page hands over null for anything it could
      // not read, so a bad number here is our parser's defect (rule 7). Thrown
      // before anything is counted, so the gate never records half an outcome.
      throw new RangeError(
        `HostGate.report: retryAfterMs must be ≥ 0 or null, got ${outcome.retryAfterMs}`,
      );
    }
    const state = this.stateFor(host);
    if (outcome.statusCode === 429) state.responses429 += 1;
    if (outcome.retryAfterMs !== null) state.retryAfterSeen += 1;
    let escalated = false;

    // A bare 503 counts as pushback for the streak — an origin answering
    // "unavailable" to several URLs in a row is struggling — but it is not a
    // rate statement on its own, so one 503 route cannot escalate anything.
    const pushback = outcome.fetchClass === "blocked" || outcome.statusCode === 503;
    if (!pushback) {
      state.streak = 0;
      state.streakUrl = null;
      state.streakDistinct = false;
    } else {
      state.streak += 1;
      if (state.streakUrl === null) state.streakUrl = outcome.url;
      else if (state.streakUrl !== outcome.url) state.streakDistinct = true;

      const namedARate = outcome.statusCode === 429 || outcome.retryAfterMs !== null;
      const hostWideStreak =
        state.streak >= ESCALATION_STREAK && state.streakDistinct;
      if (namedARate || hostWideStreak) {
        escalated = true;
        state.escalations += 1;
        state.escalationsTotal += 1;
        // Strike two: this host has already recovered at least once.
        if (state.recoveries > 0) state.recoveryLocked = true;
        this.spacingGen += 1;
        const spacing = this.spacingMs(host);
        state.peakSpacingMs = Math.max(state.peakSpacingMs, spacing);
        this.highWaterMs = Math.max(this.highWaterMs, spacing);
        this.pushSlot(host, spacing);
      }
    }

    // The bounded recovery (see "The ratchet" above).
    const code = outcome.statusCode;
    const clean =
      !pushback &&
      code !== null &&
      code >= 200 &&
      code < 500 &&
      code !== 429 &&
      outcome.retryAfterMs === null;
    if (escalated || !clean) {
      state.cleanStreak = 0;
    } else {
      state.cleanStreak += 1;
      if (
        state.cleanStreak >= RECOVERY_STREAK &&
        state.escalations > 0 &&
        !state.recoveryLocked
      ) {
        state.escalations -= 1;
        state.recoveries += 1;
        state.cleanStreak = 0;
        this.spacingGen += 1;
      }
    }

    if (outcome.retryAfterMs !== null) {
      this.pushSlot(host, Math.min(this.maxDelayMs, outcome.retryAfterMs));
    }
  }

  /**
   * Resolve when `host` may be hit again.
   *
   * The slot is claimed *before* sleeping, so N concurrent acquirers of one
   * host chain at the host's spacing apart rather than all waking on the same
   * timestamp. A host untouched for longer than the delay is admitted with no
   * wait at all (elapsed-time credit).
   */
  async acquire(host: string): Promise<void> {
    const state = this.stateFor(host);
    const now = Date.now();
    const startAt = Math.max(now, state.nextAllowedAt);
    state.nextAllowedAt = startAt + this.spacingMs(host);

    const waitMs = startAt - now;
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  /**
   * Push a host's next slot out by `delayMs` from now, never pulling it in: an
   * escalation or a `Retry-After` may arrive while siblings hold slots further
   * out already, and the later of the two is the polite one.
   */
  private pushSlot(host: string, delayMs: number): void {
    const state = this.stateFor(host);
    state.nextAllowedAt = Math.max(state.nextAllowedAt, Date.now() + delayMs);
  }

  private stateFor(host: string): HostState {
    let state = this.hosts.get(host);
    if (state === undefined) {
      state = this.freshState(this.delayMs);
      this.hosts.set(host, state);
    }
    return state;
  }

  private freshState(baseMs: number): HostState {
    return {
      nextAllowedAt: 0,
      baseMs,
      escalations: 0,
      escalationsTotal: 0,
      recoveries: 0,
      recoveryLocked: false,
      cleanStreak: 0,
      responses429: 0,
      retryAfterSeen: 0,
      peakSpacingMs: baseMs,
      streak: 0,
      streakUrl: null,
      streakDistinct: false,
    };
  }

  /** A stored base folded through the same max(config, robots, ·)/cap as every base. */
  private foldBase(storedMs: number): number {
    return Math.min(this.maxDelayMs, Math.max(this.configuredFloorMs, storedMs));
  }
}

/**
 * The throttle record a crawl's STORED `host_spacing_jsonb` carries — what
 * `crawl_status.throttle` serves, read without a gate (the crawl may be long
 * finished and its gate gone).
 *
 *  - NULL column, or the pre-24a `{host: ms}` map: `null`. Those crawls never
 *    counted anything, and a record of zeros would claim they did (rule 7).
 *  - The 24a `{host: HostSpacingEntry}` map: one `HostThrottle` per host, the
 *    same values `HostGate.throttleRecord()` held when it was snapshotted
 *    (`finalSpacingMs` is the entry's `spacingMs`).
 *  - Anything else — a mixed map, a non-object, a mistyped field — throws, as
 *    `restore()` does, through the same `parseEntry`.
 */
export function throttleRecordOf(stored: unknown): Record<string, HostThrottle> | null {
  if (stored === null || stored === undefined) return null;
  if (typeof stored !== "object" || Array.isArray(stored)) {
    throw new TypeError(
      `throttleRecordOf: host_spacing_jsonb must be a {host: …} object, got ${
        Array.isArray(stored) ? "an array" : typeof stored
      }`,
    );
  }
  const entries = Object.entries(stored as Record<string, unknown>);
  const legacy = entries.filter(([, v]) => typeof v !== "object" || v === null).length;
  if (legacy !== 0 && legacy !== entries.length) {
    throw new TypeError(
      "throttleRecordOf: host_spacing_jsonb mixes the pre-24a {host: ms} shape with the 24a {host: {…}} shape",
    );
  }
  if (legacy !== 0) return null;
  const out: Record<string, HostThrottle> = {};
  for (const [host, value] of entries) {
    const e = parseEntry(host, value as Record<string, unknown>);
    out[host] = {
      responses429: e.responses429,
      retryAfterSeen: e.retryAfterSeen,
      escalations: e.escalations,
      recoveries: e.recoveries,
      recoveryLocked: e.recoveryLocked,
      peakSpacingMs: e.peakSpacingMs,
      finalSpacingMs: e.spacingMs,
    };
  }
  return out;
}

/**
 * One 24a `host_spacing_jsonb` entry, validated field by field (hard rule 7).
 * Every field is required: an entry missing one was not written by `snapshot()`.
 */
function parseEntry(host: string, raw: Record<string, unknown>): HostSpacingEntry {
  const where = `HostGate.restore: host_spacing_jsonb[${host}]`;
  const ms = (field: string): number => {
    const v = raw[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new RangeError(`${where}.${field} must be a number of ms ≥ 0, got ${String(v)}`);
    }
    return v;
  };
  const count = (field: string): number => {
    const v = raw[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new RangeError(`${where}.${field} must be an integer ≥ 0, got ${String(v)}`);
    }
    return v;
  };
  const flag = (field: string): boolean => {
    const v = raw[field];
    if (typeof v !== "boolean") {
      throw new TypeError(`${where}.${field} must be a boolean, got ${String(v)}`);
    }
    return v;
  };
  const entry: HostSpacingEntry = {
    spacingMs: ms("spacingMs"),
    baseMs: ms("baseMs"),
    responses429: count("responses429"),
    retryAfterSeen: count("retryAfterSeen"),
    escalations: count("escalations"),
    recoveries: count("recoveries"),
    recoveryLocked: flag("recoveryLocked"),
    peakSpacingMs: ms("peakSpacingMs"),
  };
  if (entry.recoveries > entry.escalations) {
    throw new RangeError(
      `${where}: recoveries ${entry.recoveries} exceeds escalations ${entry.escalations}; every recovery undoes an escalation`,
    );
  }
  if (entry.recoveryLocked && entry.recoveries === 0) {
    throw new RangeError(
      `${where}: recoveryLocked with recoveries 0; only an escalation after a recovery locks a host`,
    );
  }
  return entry;
}

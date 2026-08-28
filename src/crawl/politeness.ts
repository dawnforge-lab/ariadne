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
 *   a `blocked` answer doubles that host's spacing, and a `Retry-After` header
 *   is honoured as a floor under the host's next slot (see `report`).
 *
 * Both halves see every settled fetch, and they compose rather than duplicate:
 * a 429 shrinks the window (fewer requests at once) AND widens that host's
 * spacing (more time between them). A token bucket wants the second; a busy
 * origin wants the first; a Shopify site behind Cloudflare hands out both
 * complaints at once.
 *
 * Pure logic — no I/O, no fetching, no database. The crawl loop wires it.
 *
 * Memory: the gate holds two small maps keyed by host — O(hosts touched), not
 * O(URLs). A site crawl touches one host, or a handful with its variants; the
 * memory contract (rule 6) is about the frontier and the page bodies, and
 * nothing here grows with either.
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
   * `Retry-After`, in milliseconds from now. Null when the response carried
   * none, or carried one we could not read — an unreadable header is recorded
   * in the page row by `fetch-page`'s `parseRetryAfter` and NEVER guessed at
   * here (hard rule 7). A value that arrives negative or non-finite is our own
   * parser's bug and is thrown, not clamped.
   */
  retryAfterMs: number | null;
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
   * 1MiB against a 64MiB default budget, so that branch is a guard, not a
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
}

export class HostGate {
  private readonly delayMs: number;
  private readonly maxDelayMs: number;
  /** host → the earliest wall-clock ms at which the next hit may start. */
  private readonly nextAllowedAt = new Map<string, number>();
  /**
   * host → how many times it has blocked us. Only ever incremented: see
   * `report` for why a success does not give the spacing back.
   */
  private readonly blocks = new Map<string, number>();
  /** The widest spacing any host has reached. Read by the loop's lease sizing. */
  private highWaterMs: number;

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
    if (!(maxDelayMs > 0)) {
      throw new RangeError(`HostGate: maxDelayMs must be > 0, got ${maxDelayMs}`);
    }

    // A site asking for a full minute between hits gets 30s: past the cap the
    // crawl stops being a crawl. Below it, the site's number always wins.
    this.delayMs = Math.min(
      maxDelayMs,
      Math.max(opts.perHostDelayMs, (opts.robotsCrawlDelaySec ?? 0) * 1000),
    );
    this.maxDelayMs = maxDelayMs;
    this.highWaterMs = this.delayMs;
  }

  /**
   * The CONFIGURED spacing: max(config, robots), capped. A fact about how the
   * crawl was set up, not about how it is going — it never moves. For what a
   * host is actually being crawled at right now, see `spacingMs`.
   */
  effectiveDelayMs(): number {
    return this.delayMs;
  }

  /** The spacing in force for `host` right now: the base, times the ratchet. */
  spacingMs(host: string): number {
    const blocks = this.blocks.get(host) ?? 0;
    if (blocks === 0) return this.delayMs;
    const seed = this.delayMs > 0 ? this.delayMs : ZERO_BASE_SEED_MS;
    return Math.min(this.maxDelayMs, seed * 2 ** blocks);
  }

  /**
   * The widest spacing any host has reached — the number a lease has to be
   * sized against, because a batch is leased before anyone knows which host's
   * escalated queue its members will sit in (see the loop's `leaseSecondsFor`).
   */
  maxSpacingMs(): number {
    return this.highWaterMs;
  }

  /**
   * Tell the gate how one fetch of `host` ended.
   *
   * Two independent effects, both of which only ever make us slower:
   *
   *  - **A `blocked` answer doubles that host's spacing** (base ×2, ×4, ×8 …,
   *    capped at `maxDelayMs`) and pushes its next slot out by the new figure,
   *    so the escalation takes effect on the very next request rather than one
   *    request later.
   *
   *    It is a RATCHET: a success afterwards does not wind it back. A token
   *    bucket that emptied once will empty again, and "we got one 200, let's
   *    speed up" is precisely how a crawl oscillates in and out of a WAF's bad
   *    books for an hour. Within one crawl the spacing only ever goes up. The
   *    escalation is also per block rather than per *consecutive* block, so a
   *    site alternating 200 and 429 keeps backing off instead of stalling at
   *    ×2 forever — the more polite of the two readings, which is the one this
   *    project takes (rule 9).
   *
   *  - **A `Retry-After` is honoured as a floor** under the next slot, on any
   *    class that carries one (a 429's, and a 503's). It competes with the
   *    escalated spacing and the longer wins; it is capped at `maxDelayMs`,
   *    because `Retry-After: 31536000` is a header a hostile or misconfigured
   *    origin can send and a year-long sleep is not a crawl.
   *
   * The gate is told immediately, per fetch, not per batch: the next acquirer
   * of this host may be a sibling already inside `acquire`.
   */
  report(host: string, outcome: HostOutcome): void {
    if (outcome.fetchClass === "blocked") {
      this.blocks.set(host, (this.blocks.get(host) ?? 0) + 1);
      const spacing = this.spacingMs(host);
      this.highWaterMs = Math.max(this.highWaterMs, spacing);
      this.pushSlot(host, spacing);
    }
    if (outcome.retryAfterMs !== null) {
      if (!Number.isFinite(outcome.retryAfterMs) || outcome.retryAfterMs < 0) {
        // Not a site problem: fetch-page hands over null for anything it could
        // not read, so a bad number here is our parser's defect (rule 7).
        throw new RangeError(
          `HostGate.report: retryAfterMs must be ≥ 0 or null, got ${outcome.retryAfterMs}`,
        );
      }
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
    const now = Date.now();
    const startAt = Math.max(now, this.nextAllowedAt.get(host) ?? 0);
    this.nextAllowedAt.set(host, startAt + this.spacingMs(host));

    const waitMs = startAt - now;
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  /**
   * Push a host's next slot out by `delayMs` from now, never pulling it in: an
   * escalation or a `Retry-After` may arrive while siblings hold slots further
   * out already, and the later of the two is the polite one.
   */
  private pushSlot(host: string, delayMs: number): void {
    const at = Date.now() + delayMs;
    this.nextAllowedAt.set(host, Math.max(this.nextAllowedAt.get(host) ?? 0, at));
  }
}

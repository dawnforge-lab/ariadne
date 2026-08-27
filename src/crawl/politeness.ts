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
 * - `HostGate` is *fixed spacing*. Adaptive concurrency alone does not give a
 *   WAF's token bucket what it wants: yellow.com.mt blocked us at a modest
 *   concurrency because the requests arrived in bursts. A per-host minimum
 *   interval, honouring robots `crawl-delay`, is the fix.
 *
 * Pure logic — no I/O, no fetching, no database. The crawl loop wires it.
 */

import type { FetchClass } from "./fetch-page.js";

/** What one settled fetch tells the governor. */
export interface BatchOutcome {
  fetchClass: FetchClass;
  responseTimeMs: number;
  htmlBytes: number;
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
  /** host → the earliest wall-clock ms at which the next hit may start. */
  private readonly nextAllowedAt = new Map<string, number>();

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
  }

  /** The spacing actually honoured: max(config, robots), capped. */
  effectiveDelayMs(): number {
    return this.delayMs;
  }

  /**
   * Resolve when `host` may be hit again.
   *
   * The slot is claimed *before* sleeping, so N concurrent acquirers of one
   * host chain at `delayMs` apart rather than all waking on the same
   * timestamp. A host untouched for longer than the delay is admitted with no
   * wait at all (elapsed-time credit).
   */
  async acquire(host: string): Promise<void> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextAllowedAt.get(host) ?? 0);
    this.nextAllowedAt.set(host, startAt + this.delayMs);

    const waitMs = startAt - now;
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

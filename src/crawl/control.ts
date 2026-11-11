/**
 * Crawl lifecycle control vocabulary (Phase 27b).
 *
 * `crawls.control_request` and `crawls.pause_reason` are free text, no DB
 * constraint, so these readers are the constraint: a value this engine did not
 * write is a defect of ours and throws naming the crawl (rule 7).
 */

import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { crawls } from "../db/schema.js";

export const CONTROL_REQUESTS = ["pause", "cancel"] as const;
export type ControlRequest = (typeof CONTROL_REQUESTS)[number];

/**
 * Why a crawl is `paused`: an agent asked (`request`), the process running it
 * shut down (`shutdown`), or its stored credentials could not be read when a
 * runner picked it up (`credentials_unreadable`, Phase 28b: the key was rotated
 * past them, they failed authentication, or the retention sweep deleted them;
 * `crawl_resume` with the values continues it), or the process running it died
 * and the reaper settled its work (`worker_lost`, Phase 28b: src/worker/
 * reaper.ts). `shutdown` and `worker_lost` are SYSTEM pauses: a worker-pool
 * crawl paused by one is requeued by the reaper — after `shutdown` always (a
 * deploy), after `worker_lost` at most three times in a row (Ruling R17).
 */
export const PAUSE_REASONS = ["request", "shutdown", "credentials_unreadable", "worker_lost"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

function readOf<T extends string>(
  column: string,
  allowed: readonly T[],
  value: unknown,
  crawlId: string,
): T | null {
  if (value === null) return null;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `crawl '${crawlId}' has ${column} ${JSON.stringify(value)}, which this engine never writes (expected null or one of ${allowed.join(", ")})`,
  );
}

export function readControlRequest(value: unknown, crawlId: string): ControlRequest | null {
  return readOf("control_request", CONTROL_REQUESTS, value, crawlId);
}

export function readPauseReason(value: unknown, crawlId: string): PauseReason | null {
  return readOf("pause_reason", PAUSE_REASONS, value, crawlId);
}

/**
 * How often a running crawl reads `crawls.control_request`. A pause or cancel
 * takes effect within one of these plus the abort's settle time (the in-flight
 * fetches reject at once; the batch then flushes and the leases go back).
 */
export const CONTROL_POLL_MS = 1000;

/** Why a run stopped short of draining its frontier. */
export type StopReason = { kind: "cancel" } | { kind: "pause"; reason: PauseReason };

/**
 * Ask a RUNNING crawl to pause or cancel. Control goes through the database,
 * not process memory, so the request reaches whichever process holds the crawl
 * (Phase 28 runs several). Answers whether a row was updated: false means the
 * crawl was not `running` when the statement ran, and nothing was asked.
 */
export async function setControlRequest(
  db: Db,
  crawlId: string,
  request: ControlRequest,
): Promise<boolean> {
  const res = await db
    .update(crawls)
    .set({ controlRequest: request })
    .where(and(eq(crawls.id, crawlId), eq(crawls.status, "running")));
  if (res.rowCount === null) {
    throw new Error(
      `setControlRequest: the update of crawl ${crawlId} reported no row count, so whether ` +
        `the request was recorded is unknown`,
    );
  }
  return res.rowCount > 0;
}

/**
 * The crawl loop's ear for control requests, and the one signal the loop stops
 * on.
 *
 * Three things abort `signal`:
 *  - a non-null `crawls.control_request`, read every `pollMs`;
 *  - the process's own shutdown signal (`opts.shutdown`): a shutdown is a
 *    pause, reason `shutdown`;
 *  - a poll that throws. That is not "no request" (rule 7): `failure()` holds
 *    the error and the loop ends the run `failed` with it.
 *
 * Polling continues after the abort until `stop()`, so a cancel that follows a
 * pause during the wind-down still upgrades `stopReason()`. The loop's close
 * re-reads the column in the same UPDATE anyway; the watcher's record is what
 * that close is checked against.
 */
export class ControlWatcher {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly pollMs: number;
  private readonly shutdown: AbortSignal | undefined;
  private request: ControlRequest | null = null;
  private shutdownSeen = false;
  private failed: { error: unknown } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private readonly onShutdown = (): void => {
    this.shutdownSeen = true;
    this.controller.abort();
  };

  constructor(
    private readonly db: Db,
    private readonly crawlId: string,
    opts: { shutdown?: AbortSignal; pollMs?: number } = {},
  ) {
    const pollMs = opts.pollMs ?? CONTROL_POLL_MS;
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new RangeError(`ControlWatcher: pollMs must be > 0, got ${pollMs}`);
    }
    this.pollMs = pollMs;
    this.shutdown = opts.shutdown;
    this.signal = this.controller.signal;
  }

  start(): void {
    if (this.started) throw new Error(`ControlWatcher for crawl ${this.crawlId} started twice`);
    this.started = true;
    if (this.shutdown !== undefined) {
      if (this.shutdown.aborted) this.onShutdown();
      else this.shutdown.addEventListener("abort", this.onShutdown, { once: true });
    }
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  /** Stop polling and wait out a poll in flight. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.shutdown?.removeEventListener("abort", this.onShutdown);
    if (this.inFlight !== null) await this.inFlight;
  }

  /** Why the run must stop, or null: cancel > pause (request) > pause (shutdown). */
  stopReason(): StopReason | null {
    if (this.request === "cancel") return { kind: "cancel" };
    if (this.request === "pause") return { kind: "pause", reason: "request" };
    if (this.shutdownSeen) return { kind: "pause", reason: "shutdown" };
    return null;
  }

  /** The error a poll threw, or null. A non-null failure ends the run `failed`. */
  failure(): unknown | null {
    return this.failed === null ? null : this.failed.error;
  }

  private tick(): void {
    // One poll at a time: a slow database must not stack reads up behind it.
    if (this.stopped || this.inFlight !== null) return;
    this.inFlight = this.poll().finally(() => {
      this.inFlight = null;
    });
  }

  private async poll(): Promise<void> {
    try {
      const rows = await this.db
        .select({ controlRequest: crawls.controlRequest })
        .from(crawls)
        .where(eq(crawls.id, this.crawlId));
      const row = rows[0];
      if (row === undefined) {
        throw new Error(
          `crawl ${this.crawlId}: the crawls row is gone; cannot read its control request`,
        );
      }
      const request = readControlRequest(row.controlRequest, this.crawlId);
      if (request === null) return;
      // A cancel overrides a pause; nothing downgrades a cancel.
      if (this.request !== "cancel") this.request = request;
      this.controller.abort();
    } catch (error) {
      if (this.failed === null) this.failed = { error };
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.controller.abort();
    }
  }
}

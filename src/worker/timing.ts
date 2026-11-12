/**
 * The worker clock (Phase 28b), in milliseconds. One place, every value
 * injectable, so a test runs the same code on a 50 ms clock.
 *
 *  - `heartbeat`: how often a process stamps its instance and running jobs.
 *  - `deadAfter`: an instance whose heartbeat is older than this is dead, and
 *    its jobs are the reaper's (Task 4).
 *  - `reapEvery`: how often a live instance runs the reaper (Task 4).
 *  - `instanceRetention`: dead instance rows older than this are deleted.
 *  - `claimPoll`: how often an idle runner asks the queue for work. A runner
 *    is also woken at once when its own process enqueues and when one of its
 *    jobs ends, so this bounds only how long work enqueued by ANOTHER process
 *    waits for an idle runner.
 *  - `scheduleEvery` (28c): how often a scheduler candidate tries the leader
 *    lock, and how often the leader fires the due schedules
 *    (src/schedule/scheduler.ts).
 */
export interface Timing {
  heartbeat: number;
  deadAfter: number;
  reapEvery: number;
  instanceRetention: number;
  claimPoll: number;
  scheduleEvery: number;
}

export const DEFAULT_TIMING: Readonly<Timing> = Object.freeze({
  heartbeat: 10_000,
  deadAfter: 60_000,
  reapEvery: 30_000,
  instanceRetention: 24 * 60 * 60 * 1000,
  claimPoll: 1_000,
  scheduleEvery: 30_000,
});

/**
 * The defaults with `overrides` applied. Every value must be a positive whole
 * number of milliseconds, and an instance must be able to miss a heartbeat
 * before it is called dead: anything else is refused, naming the field,
 * rather than run on a clock that reaps live work.
 */
export function timingWith(overrides: Partial<Timing> = {}): Timing {
  const timing: Timing = { ...DEFAULT_TIMING, ...overrides };
  for (const [field, value] of Object.entries(timing)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `timing.${field} must be a positive whole number of milliseconds, got ${String(value)}`,
      );
    }
  }
  if (timing.deadAfter <= timing.heartbeat) {
    throw new Error(
      `timing.deadAfter (${timing.deadAfter} ms) must exceed timing.heartbeat ` +
        `(${timing.heartbeat} ms): a live instance would be reaped between two of its heartbeats`,
    );
  }
  return timing;
}

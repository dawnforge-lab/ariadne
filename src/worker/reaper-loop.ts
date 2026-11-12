/**
 * The reaper's timer (Phase 28b, Ruling R10): `reapOnce` every
 * `timing.reapEvery`, one tick at a time, and a log line when a tick did
 * something or failed.
 *
 * ONE implementation for the two owners that run it — a `JobRunner` built with
 * `reaper` (a worker), and `api:serve` in `workers` mode, which has no runner
 * but must settle its own dead render/rules jobs and sweep credentials. An
 * in-process service owns neither and runs none.
 *
 * Nothing here throws into the void: a tick that fails is logged and the next
 * tick tries again (`reapOnce` itself runs every step and reports every
 * failure together, so one failing step never starves the others).
 */
import type { Db } from "../db/client.js";
import type { CredentialVault } from "../crawl/credential-vault.js";
import { reapOnce, type ReapSummary } from "./reaper.js";
import type { Timing } from "./timing.js";

export interface ReaperLoopOptions {
  vault: CredentialVault;
  /** Credential retention in days after a crawl settles. */
  retentionDays: number;
  timing: Timing;
  /** What the owner calls itself in a line: `runner instance_x`, `api instance_x`. */
  label: string;
  log: (line: string) => void;
  /**
   * TEST ONLY (`ReapOptions.onlyInstances`): production never passes it. A
   * function is read at every tick, for a test whose confinement is not known
   * until its processes have registered.
   */
  onlyInstances?: readonly string[] | (() => readonly string[]);
}

export class ReaperLoop {
  private timer: NodeJS.Timeout | null = null;
  /** The tick in flight, if any: ticks never overlap. */
  private reaping: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly opts: ReaperLoopOptions,
  ) {}

  /** Begin ticking, once per `timing.reapEvery`. */
  start(): void {
    if (this.timer !== null || this.stopped) throw new Error(`${this.opts.label}: the reaper is already started or stopped`);
    this.timer = setInterval(() => this.tick(), this.opts.timing.reapEvery);
    // The reaper alone never keeps a process alive.
    this.timer.unref();
  }

  /** No tick after this one; a tick in flight is left to finish (`stop()` waits for it). */
  halt(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** `halt()`, then wait for the tick in flight: its transactions settle what they took. */
  async stop(): Promise<void> {
    this.halt();
    if (this.reaping !== null) await this.reaping;
  }

  private tick(): void {
    if (this.stopped || this.reaping !== null) return;
    const only = this.opts.onlyInstances;
    const confined = typeof only === "function" ? only() : only;
    this.reaping = reapOnce(this.db, {
      now: new Date(),
      timing: this.opts.timing,
      vault: this.opts.vault,
      retentionDays: this.opts.retentionDays,
      ...(confined === undefined ? {} : { onlyInstances: confined }),
    })
      .then((summary) => {
        if (reapedSomething(summary)) this.opts.log(`${this.opts.label}: reaper — ${describeReap(summary)}`);
      })
      .catch((error: unknown) => {
        this.opts.log(
          `${this.opts.label}: the reaper's tick failed — ${messageOf(error)}; retrying at the next tick`,
        );
      })
      .finally(() => {
        this.reaping = null;
      });
  }
}

function reapedSomething(summary: ReapSummary): boolean {
  return Object.values(summary).some((n) => n > 0);
}

function describeReap(summary: ReapSummary): string {
  return (
    `${summary.abandonedJobs} dead job(s) abandoned, ${summary.pausedCrawls} crawl(s) paused, ` +
    `${summary.cancelledCrawls} cancelled, ${summary.requeuedCrawls} requeued, ` +
    `${summary.credentialsSwept} expired credential row(s) swept, ` +
    `${summary.instancesDeleted} dead instance(s) deleted`
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

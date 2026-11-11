/**
 * `JobRunner` (Phase 28b): claims jobs from the queue and runs them, up to a
 * concurrency.
 *
 * It claims when it starts, every `timing.claimPoll` while it has room, when
 * one of its jobs ends, and whenever its owner calls `wake()` — the in-process
 * service wakes it the moment it enqueues, and waits for that claim, so a
 * crawl started on an idle server answers `queuePosition: 0` as it always has.
 *
 * Every job is settled by how its work ended: `done` when `execute` resolves,
 * `failed` (with the error's first line) when it throws, `abandoned` when it
 * resolved because the runner stopped it. Work that settles its own job in the
 * transaction that ends it (a crawl's close) has already done so, and that
 * answer stands (`finishJob`).
 *
 * `stop()` stops claiming, then aborts every running job and waits for each
 * to end — a crawl closes `paused` (`shutdown`) through its loop, as it did
 * before 28b. Queued jobs are not this runner's until it claims them, so they
 * stay queued. A claim that lands after `stop()` began is handed back to the
 * queue untouched rather than started only to be aborted.
 *
 * Nothing here throws into the void: a claim that fails is logged and retried
 * at the next tick, and each job's promise is caught before anyone awaits it,
 * because an unhandled rejection ends a Node 22 process and one bad job must
 * not take the server with it.
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { assertTenantCap, claimNextJob, finishJob, type ClaimedJob, type JobKind, type JobOutcome } from "./jobs.js";
import { heartbeat } from "./instance.js";
import { timingWith, type Timing } from "./timing.js";

/** `ARIADNE_TENANT_MAX_RUNNING` when it is not set (R9). */
export const DEFAULT_TENANT_MAX_RUNNING = 1;

/**
 * `ARIADNE_TENANT_MAX_RUNNING`: how many unpinned crawl jobs one tenant may
 * have running across the worker pool. Unset is the default, 1; anything set
 * must be a positive whole number written plainly (`4`, not `04`, ` 4` or
 * `4e0`), or it is refused naming the variable — never read as the default.
 */
export function parseTenantMaxRunning(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TENANT_MAX_RUNNING;
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(
      `ARIADNE_TENANT_MAX_RUNNING must be a positive whole number, got ${JSON.stringify(raw.slice(0, 40))}`,
    );
  }
  return value;
}

export interface JobRunnerOptions {
  /** The `instances` row this runner claims as (`claimed_by`). */
  instanceId: string;
  kinds: readonly JobKind[];
  /** Claim jobs pinned to this instance id, or (null) the unpinned pool. */
  pinnedTo: string | null;
  /**
   * How many unpinned crawl jobs one tenant may have running across the pool
   * (R9; `parseTenantMaxRunning` reads `ARIADNE_TENANT_MAX_RUNNING` where a
   * worker-pool runner is built). Required when `pinnedTo` is null; refused
   * otherwise — a pinned runner is not capped per tenant.
   */
  maxRunningPerTenant?: number;
  /** How many jobs run at once. A positive whole number. */
  concurrency: number;
  execute: (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
  timing?: Partial<Timing>;
  /** Where the runner reports what it could not do. Defaults to `console.error`. */
  log?: (line: string) => void;
  /**
   * Whether the runner heartbeats its instance (and its running jobs) every
   * `timing.heartbeat`. Default true. False only for an owner that beats the
   * same instance itself (the API service, whose instance also holds its
   * pinned render and rules jobs, beats it with this runner's job ids).
   */
  heartbeat?: boolean;
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

export class JobRunner {
  private readonly timing: Timing;
  private readonly log: (line: string) => void;
  private readonly running = new Map<string, Running>();
  /** Claims run one after another: a wake during a claim queues behind it. */
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: JobRunnerOptions,
  ) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`JobRunner: concurrency must be a positive whole number, got ${String(opts.concurrency)}`);
    }
    if (opts.kinds.length === 0) throw new Error("JobRunner: a runner must run at least one kind of job");
    assertTenantCap(opts.pinnedTo, opts.maxRunningPerTenant, "JobRunner");
    this.timing = timingWith(opts.timing);
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** Begin claiming. Once only. */
  start(): void {
    if (this.started) throw new Error(`JobRunner ${this.opts.instanceId}: already started`);
    this.started = true;
    this.timer = setInterval(() => void this.wake(), this.timing.claimPoll);
    // The poll alone never keeps a process alive: running work does.
    this.timer.unref();
    if (this.opts.heartbeat !== false) {
      // Liveness: only a live instance's jobs count as held (Ruling R10).
      this.beat = setInterval(() => {
        heartbeat(this.db, this.opts.instanceId, this.runningJobIds()).catch((error: unknown) => {
          this.log(`runner ${this.opts.instanceId}: heartbeat failed — ${messageOf(error)}`);
        });
      }, this.timing.heartbeat);
      this.beat.unref();
    }
    void this.wake();
  }

  /**
   * Claim now, as far as there is room. Resolves once this claim has been
   * made and its jobs started (not finished). Never rejects.
   */
  wake(): Promise<void> {
    if (!this.started || this.stopped) return Promise.resolve();
    this.chain = this.chain.then(() => this.fill());
    return this.chain;
  }

  /** The ids of the jobs running now. */
  runningJobIds(): string[] {
    return [...this.running.keys()];
  }

  /** Stop claiming, abort every running job, and wait for each to settle. */
  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.beat !== null) clearInterval(this.beat);
    this.stopping = (async () => {
      await this.chain;
      const current = [...this.running.values()];
      for (const job of current) job.controller.abort();
      await Promise.all(current.map((job) => job.done));
    })();
    return this.stopping;
  }

  private async fill(): Promise<void> {
    while (!this.stopped && this.running.size < this.opts.concurrency) {
      let job: ClaimedJob | null;
      try {
        job = await claimNextJob(this.db, {
          instanceId: this.opts.instanceId,
          kinds: this.opts.kinds,
          pinnedTo: this.opts.pinnedTo,
          ...(this.opts.maxRunningPerTenant === undefined ? {} : { maxRunningPerTenant: this.opts.maxRunningPerTenant }),
        });
      } catch (error) {
        this.log(`runner ${this.opts.instanceId}: claiming a job failed — ${messageOf(error)}; retrying at the next tick`);
        return;
      }
      if (job === null) return;
      if (this.stopped) {
        await this.handBack(job);
        return;
      }
      this.begin(job);
    }
  }

  private begin(job: ClaimedJob): void {
    const controller = new AbortController();
    const done = this.run(job, controller.signal).finally(() => {
      this.running.delete(job.id);
      void this.wake();
    });
    this.running.set(job.id, { controller, done });
  }

  /** Never rejects: see the module header. */
  private async run(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    let outcome: JobOutcome;
    let error: string | undefined;
    try {
      await this.opts.execute(job, signal);
      outcome = signal.aborted ? "abandoned" : "done";
    } catch (caught) {
      outcome = "failed";
      error = messageOf(caught);
      this.log(`runner ${this.opts.instanceId}: ${job.kind} job ${job.id} (crawl ${job.crawlId}) failed — ${error}`);
    }
    try {
      await finishJob(this.db, job.id, outcome, error);
    } catch (finishError) {
      this.log(
        `runner ${this.opts.instanceId}: ${job.kind} job ${job.id} (crawl ${job.crawlId}) ended ` +
          `${outcome} and could not be settled — ${messageOf(finishError)}`,
      );
    }
  }

  /** A job claimed after `stop()` began goes back to the queue as it was. */
  private async handBack(job: ClaimedJob): Promise<void> {
    try {
      await this.db
        .update(jobs)
        .set({ status: "queued", claimedBy: null, claimedAt: null, heartbeatAt: null })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.claimedBy, this.opts.instanceId)));
    } catch (error) {
      this.log(
        `runner ${this.opts.instanceId}: ${job.kind} job ${job.id} was claimed as the runner stopped ` +
          `and could not be handed back — ${messageOf(error)}`,
      );
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
import { claimNextJob, finishJob, type ClaimedJob, type JobKind, type JobOutcome } from "./jobs.js";
import { timingWith, type Timing } from "./timing.js";

export interface JobRunnerOptions {
  /** The `instances` row this runner claims as (`claimed_by`). */
  instanceId: string;
  kinds: readonly JobKind[];
  /** Claim jobs pinned to this instance id, or (null) the unpinned pool. */
  pinnedTo: string | null;
  /** How many jobs run at once. A positive whole number. */
  concurrency: number;
  execute: (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
  timing?: Partial<Timing>;
  /** Where the runner reports what it could not do. Defaults to `console.error`. */
  log?: (line: string) => void;
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

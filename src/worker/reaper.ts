/**
 * The reaper (Phase 28b item 8, Task 4b): what a dead process left behind,
 * settled by a live one. `reapOnce` is one tick; a `JobRunner` built with
 * `reaper` runs it every `timing.reapEvery` (src/worker/runner.ts) — a worker,
 * or the API in workers mode, never an in-process service (Ruling R10).
 *
 * ## One tick, in order
 *
 *  1. **Dead running jobs are abandoned.** A `running` job whose holder is not
 *     live — the negation of `liveHolderSql`, the one predicate every "held"
 *     question reads: its instance stopped, gone, or silent for `deadAfter` on
 *     the database's clock. Every kind: a dead pinned render or rules job would
 *     otherwise hold the crawl's one-live-job index for ever. A `crawl` job's
 *     crawl, when it is `queued` (claimed, not yet started) or `running`, is
 *     closed as the run's own stopped close would have closed it — a pending
 *     cancel `cancelled` (its credentials removed with it), a pending pause
 *     `paused` (`request`), anything else `paused` (`worker_lost`) — with the
 *     frontier's crawled count, and its frontier leases are released with the
 *     attempt refunded (`releaseLeases(…, null, {refundAttempt: true})`: every
 *     live lease in the crawl, which is safe only because the one process that
 *     could hold them is dead). A `render` or `rules` job's crawl is left as
 *     it was before the call: a re-run is the caller's to ask for.
 *  2. **System pauses are requeued.** A crawl `paused` with `shutdown` or
 *     `worker_lost`, fewer than `AUTO_RESUME_LIMIT` requeues in a row
 *     (`auto_resume_count`), no live job, and whose LATEST crawl job was
 *     unpinned — a worker-pool crawl — goes back to `queued` with a fresh
 *     unpinned crawl job of this code's versions, in one transaction: the same
 *     state change as `crawl_resume`, made by the engine, its count up by one.
 *     Never `request` (an agent's pause is never undone), never
 *     `credentials_unreadable` (only new values continue it), never a pinned
 *     (in-process) crawl, whose process is the only runner of its pin (R10).
 *  3. **Expired credentials are swept** (`CredentialVault.sweepExpired`,
 *     retention `retentionDays`).
 *  4. **Dead instance rows are deleted** once older than
 *     `timing.instanceRetention` — and only once they hold no `queued` or
 *     `running` job, so a queued job still pinned to one stays readable as
 *     "pinned to a dead instance" until `crawl_resume` adopts it.
 *
 * QUEUED JOBS PINNED TO A DEAD INSTANCE ARE LEFT ALONE (R10 revised): their
 * crawl is `queued`, and `crawl_resume` adopts it (a fresh job, this caller's
 * pin and versions). Abandoning one here would strand a queued crawl with no
 * job at all.
 *
 * ## Two reapers, and the locks
 *
 * Every live instance with a reaper ticks, so two can meet over one dead job.
 * Each job is settled in its own transaction that locks the job's CRAWL row
 * `FOR UPDATE SKIP LOCKED` and then the job row, re-reading that the job is
 * still running and dead: a crawl another reaper (or a closing run, or a
 * resume) holds is skipped this tick, and a job the first reaper settled reads
 * settled to the second. Crawl row first, then job row — the order every
 * writer of the pair takes (the loop's close and its job settle, `crawl_resume`,
 * `crawl_mark_failed`, a pause or cancel of a queued crawl), so two of them
 * never wait on each other in a cycle.
 *
 * ## `onlyInstances` — TEST ONLY (Ruling R11)
 *
 * Confines steps 1, 2 and 4 to those instances: dead jobs they claimed, crawls
 * whose latest crawl job one of them claimed, their own instance rows. The
 * test suite's files share one database and test the reaper on a 300 ms clock;
 * an unconfined tick would pause, requeue and delete other suites' rows.
 * Production never passes it. (Step 3 is the sweep's own: it reads no
 * instance, and a test passes a retention long enough to touch nothing but
 * its own rows.)
 */
import { and, eq, sql, type SQL } from "drizzle-orm";

import { crawls, jobs } from "../db/schema.js";
import type { CredentialVault } from "../crawl/credential-vault.js";
import { crawledRows, frontierCounts, releaseLeases } from "../crawl/frontier.js";
import { PAUSE_REASONS, type PauseReason } from "../crawl/control.js";
import { enqueueJob, JobBusyError, liveHolderSql, liveInstanceSql, type Writer } from "./jobs.js";
import type { Timing } from "./timing.js";
import type { TenantId } from "../tenant.js";

/** How many times in a row the reaper requeues one crawl (plan deviation 1); `crawl_resume` resets the count. */
export const AUTO_RESUME_LIMIT = 3;

/** The pauses the engine made and the engine undoes (spec item 8). */
export const SYSTEM_PAUSE_REASONS = ["shutdown", "worker_lost"] as const satisfies readonly PauseReason[];

export interface ReapOptions {
  /** The tick's time, for the credential sweep. Liveness reads the database's clock. */
  now: Date;
  timing: Timing;
  vault: CredentialVault;
  /** Credential retention in days after a crawl settles (`ARIADNE_CREDENTIALS_RETENTION_DAYS`). */
  retentionDays: number;
  /** TEST ONLY (module header, Ruling R11). Production never passes it. */
  onlyInstances?: readonly string[];
}

/** What one tick did. Each count is rows this tick moved, never rows it read. */
export interface ReapSummary {
  /** Running jobs of dead instances, now `abandoned`. */
  abandonedJobs: number;
  /** Their crawls closed `paused` (`worker_lost`, or `request` when a pause was pending). */
  pausedCrawls: number;
  /** Their crawls closed `cancelled`, because an agent's cancel was pending on the dead run. */
  cancelledCrawls: number;
  /** System-paused worker-pool crawls put back in the queue. */
  requeuedCrawls: number;
  /** Credential rows the retention sweep deleted. */
  credentialsSwept: number;
  /** Dead instance rows deleted. */
  instancesDeleted: number;
}

export async function reapOnce(db: Writer, opts: ReapOptions): Promise<ReapSummary> {
  if (opts.onlyInstances !== undefined && opts.onlyInstances.length === 0) {
    // An empty confinement would confine to nothing, which no test means.
    throw new Error("reapOnce: onlyInstances, when given, names at least one instance");
  }
  const summary: ReapSummary = {
    abandonedJobs: 0,
    pausedCrawls: 0,
    cancelledCrawls: 0,
    requeuedCrawls: 0,
    credentialsSwept: 0,
    instancesDeleted: 0,
  };
  const deadAfter = opts.timing.deadAfter;

  // 1. Dead running jobs. The candidates are read once — running jobs are as
  //    many as the engine's total concurrency — and each is settled in its own
  //    transaction that re-reads it under its locks.
  const candidates = await db.execute<{ id: string; crawl_id: string }>(sql`
    select j.id, j.crawl_id from jobs j
     where j.status = 'running' and not ${liveHolderSql(deadAfter)}
       ${confined(sql`j.claimed_by`, opts.onlyInstances)}
     order by j.claimed_at, j.id`);
  for (const candidate of candidates.rows) {
    const reaped = await reapJob(db, candidate.id, candidate.crawl_id, deadAfter, opts.vault);
    if (reaped === null) continue;
    summary.abandonedJobs += 1;
    if (reaped === "paused") summary.pausedCrawls += 1;
    if (reaped === "cancelled") summary.cancelledCrawls += 1;
  }

  // 2. System pauses back in the queue. One crawl per transaction; a crawl a
  //    synchronous render or rules call took between the read and the insert
  //    (the one-live-job index refuses the job) waits for the next tick.
  const skipped: string[] = [];
  for (;;) {
    const outcome = await requeueOne(db, skipped, opts.onlyInstances);
    if (outcome === null) break;
    if (outcome.requeued) summary.requeuedCrawls += 1;
    else skipped.push(outcome.crawlId);
  }

  // 3. Credential retention.
  summary.credentialsSwept = await opts.vault.sweepExpired(opts.now, opts.retentionDays);

  // 4. Dead instance rows, past retention and holding nothing.
  const deleted = await db.execute(sql`
    delete from instances i
     where not ${liveInstanceSql(sql`i.id`, deadAfter)}
       and i.heartbeat_at < now() - (${opts.timing.instanceRetention}::bigint * interval '1 millisecond')
       and not exists (select 1 from jobs j where j.status = 'running' and j.claimed_by = i.id)
       and not exists (select 1 from jobs j where j.status = 'queued' and j.pinned_to = i.id)
       ${confined(sql`i.id`, opts.onlyInstances)}
     returning i.id`);
  summary.instancesDeleted = deleted.rows.length;
  return summary;
}

/**
 * Settle one dead running job, or null when it is no longer this tick's: its
 * crawl row is locked by another writer (skipped — the next tick sees it), or
 * the job, re-read under the locks, is settled or live again. Answers what
 * became of its crawl.
 */
async function reapJob(
  db: Writer,
  jobId: string,
  crawlId: string,
  deadAfter: number,
  vault: CredentialVault,
): Promise<"paused" | "cancelled" | "untouched" | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select id from crawls where id = ${crawlId} for update skip locked`);
    if (locked.rows.length === 0) return null;
    const found = await tx.execute<{ kind: string }>(sql`
      select j.kind from jobs j
       where j.id = ${jobId} and j.status = 'running' and not ${liveHolderSql(deadAfter)}
       for update of j`);
    const job = found.rows[0];
    if (job === undefined) return null;
    await tx
      .update(jobs)
      .set({ status: "abandoned", finishedAt: new Date(), error: null })
      .where(eq(jobs.id, jobId));
    if (job.kind !== "crawl") return "untouched";

    // The dead run's close, as its own stopped close would have written it
    // (src/crawl/loop.ts, `closeCrawlOn`): the request on the row decides,
    // read in the same statement. Only a crawl the run held — `queued`
    // (claimed, not started) or `running`. The page count is the frontier's,
    // as the loop's own closes count it: the dead process's counter died with it.
    const crawled = crawledRows(await frontierCounts(tx, crawlId));
    const closed = await tx.execute<{ status: string; pause_reason: string | null }>(sql`
      update crawls set
        status = case when control_request = 'cancel' then 'cancelled' else 'paused' end,
        pause_reason = case when control_request = 'cancel' then null
                            when control_request = 'pause' then 'request'
                            else 'worker_lost' end,
        cancelled_at = case when control_request = 'cancel' then now() else null end,
        control_request = null,
        failure_reason = null,
        finished_at = now(),
        pages_crawled = ${crawled}
       where id = ${crawlId} and status in ('queued', 'running')
       returning status, pause_reason`);
    // Its leases whatever the crawl now says: the dead job was the only holder
    // of this crawl's crawl-pass leases (one live job per crawl), and its
    // process is gone.
    await releaseLeases(tx, crawlId, null, { refundAttempt: true });
    const row = closed.rows[0];
    if (row === undefined) return "untouched";
    if (row.status === "cancelled") {
      // A cancelled crawl never runs again: its credentials go with it, as
      // every other cancel removes them.
      await vault.remove(tx, crawlId);
      return "cancelled";
    }
    if (row.status !== "paused" || !PAUSE_REASONS.some((r) => r === row.pause_reason)) {
      throw new Error(
        `reaper: crawl ${crawlId}'s close came back '${row.status}' with pause reason ` +
          `${String(row.pause_reason)}, which this engine never writes`,
      );
    }
    return "paused";
  });
}

/**
 * Requeue one system-paused worker-pool crawl (module header, step 2), or
 * null when none is left this tick. `{requeued: false}` names a crawl the
 * one-live-job index refused, to skip until the next tick.
 */
async function requeueOne(
  db: Writer,
  skipped: readonly string[],
  onlyInstances: readonly string[] | undefined,
): Promise<{ crawlId: string; requeued: boolean } | null> {
  // LITERALS, not parameters: `crawls_system_paused` (migration 0043) is a
  // partial index on exactly this predicate, and the planner proves a partial
  // index usable only from constants. Both are this module's own constants.
  const systemPaused = sql.raw(
    `c.status = 'paused' and c.pause_reason in (${SYSTEM_PAUSE_REASONS.map((r) => `'${r}'`).join(", ")}) ` +
      `and c.auto_resume_count < ${AUTO_RESUME_LIMIT}`,
  );
  const notSkipped =
    skipped.length === 0 ? sql`` : sql`and c.id not in (${sql.join(skipped.map((id) => sql`${id}`), sql`, `)})`;
  // The latest crawl job decides who ran the crawl: unpinned is the worker
  // pool's, pinned an in-process service's. `is true`: a crawl with no crawl
  // job at all (one older than 28b) is nobody's to requeue.
  const latestUnpinned = sql`(select (j.pinned_to is null ${confined(sql`j.claimed_by`, onlyInstances)})
                                from jobs j
                               where j.crawl_id = c.id and j.kind = 'crawl'
                               order by j.queued_at desc, j.id desc
                               limit 1) is true`;
  let picked: { id: string; tenant_id: string } | undefined;
  try {
    return await db.transaction(async (tx) => {
      const found = await tx.execute<{ id: string; tenant_id: string }>(sql`
        select c.id, c.tenant_id from crawls c
         where ${systemPaused}
           ${notSkipped}
           and not exists (select 1 from jobs l where l.crawl_id = c.id and l.status in ('queued', 'running'))
           and ${latestUnpinned}
         order by c.finished_at, c.id
         for update of c skip locked
         limit 1`);
      picked = found.rows[0];
      if (picked === undefined) return null;
      const crawlId = picked.id;
      const moved = await tx
        .update(crawls)
        .set({
          status: "queued",
          autoResumeCount: sql`${crawls.autoResumeCount} + 1`,
          // `crawl_resume`'s own state change (src/api/service.ts): a queued
          // crawl has not finished, has no pause reason, carries no earlier
          // run's failure, and its rules marker is cleared — it is about to
          // grow pages that judgement has not seen.
          finishedAt: null,
          pauseReason: null,
          failureReason: null,
          rulesRunAt: null,
          rulesJudgedWith: null,
        })
        .where(and(eq(crawls.id, crawlId), eq(crawls.status, "paused")))
        .returning({ id: crawls.id });
      if (moved.length !== 1) {
        throw new Error(`reaper: crawl ${crawlId} was locked paused and its requeue moved ${moved.length} row(s)`);
      }
      await enqueueJob(tx, { tenant: picked.tenant_id as TenantId, crawlId, kind: "crawl" });
      return { crawlId, requeued: true };
    });
  } catch (error) {
    // The index refused the job: a render or rules call took the crawl after
    // the read. The transaction rolled back whole; the next tick tries again.
    if (error instanceof JobBusyError && picked !== undefined) return { crawlId: picked.id, requeued: false };
    throw error;
  }
}

/** `and <column> in (<onlyInstances>)`, or nothing in production. */
function confined(column: SQL, onlyInstances: readonly string[] | undefined): SQL {
  if (onlyInstances === undefined) return sql``;
  return sql`and ${column} in (${sql.join(onlyInstances.map((id) => sql`${id}`), sql`, `)})`;
}

/**
 * The durable queue (Phase 28b item 6): enqueue, claim, finish, and the busy
 * guard. Every write to `jobs` goes through here.
 *
 * ## What a job is
 *
 * One piece of work on one crawl: a `crawl` run (a start or a resume), a
 * `render` pass, or a `rules` run. The crawl's own `status` stays the
 * agent-facing truth (`queued/running/paused/…`); the job is the engine's
 * bookkeeping behind it — who holds the work, since when, and how it ended.
 *
 * ## The busy guard is an index
 *
 * `jobs_one_live_per_crawl` allows one `queued|running` job per crawl. Before
 * 28b the API service kept a queue array and two in-process sets (`judging`,
 * `rendering`), so two processes over one database could each believe a crawl
 * was free. Now a second live job for a crawl is refused by Postgres, and the
 * refusal is turned into the sentence the in-process guard gave for that
 * operation (`JobBusyError`), so the 409s a caller reads did not change.
 *
 * ## Pins
 *
 * `pinned_to` names the one instance that may run a job; null means any
 * runner. A claim takes jobs pinned EXACTLY as it asks — `pinnedTo: X` the
 * jobs pinned to X, `pinnedTo: null` the unpinned pool — and never both: an
 * in-process service runs only the crawls it accepted (its pin), a worker
 * runs the unpinned pool, and neither takes the other's work. (The spec's
 * "not pinned elsewhere" would let a pinned runner take unpinned work too; no
 * Phase 28b runner wants that, and the suite's many in-process services over
 * one database must not run one another's crawls. Deviation noted in the
 * Task 3 report.)
 *
 * ## Version skew
 *
 * A job records the `RULESET_VERSION` and `EXTRACTION_VERSION` of the code that
 * enqueued it, and a runner claims only jobs whose versions are its own: on a
 * rolling deploy old runners drain old jobs, and nothing is judged or
 * extracted by a ruleset other than the one that accepted it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { ServiceError } from "../api/errors.js";
import { EXTRACTION_VERSION } from "../crawl/versions.js";
import { RULESET_VERSION } from "../rules/registry/registry.js";
import type { TenantId } from "../tenant.js";

export type JobKind = "crawl" | "render" | "rules";
export const JOB_KINDS: readonly JobKind[] = ["crawl", "render", "rules"];

export type JobStatus = "queued" | "running" | "done" | "failed" | "abandoned";
export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "done", "failed", "abandoned"];

/** How a job ends. `abandoned`: its work stopped without an outcome of its own. */
export type JobOutcome = "done" | "failed" | "abandoned";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The pool or a transaction: anything that runs a statement. */
export type Writer = Db | Tx;
/** Anything that reads: the pool, a transaction, a read-only snapshot. */
export type Reader = Pick<Db, "select" | "execute">;

/** A job a runner has claimed: it is `running`, held by `claimedBy`. */
export interface ClaimedJob {
  id: string;
  tenant: TenantId;
  crawlId: string;
  kind: JobKind;
  pinnedTo: string | null;
  claimedBy: string;
  claimedAt: Date;
}

/** A crawl's live (`queued|running`) job, as the guards read it. */
export interface LiveJob {
  id: string;
  kind: JobKind;
  status: "queued" | "running";
  pinnedTo: string | null;
  claimedBy: string | null;
}

const LIVE_INDEX = "jobs_one_live_per_crawl";

// ------------------------------------------------------------------ refusals

/**
 * The sentences the in-process guards gave before 28b, word for word, so the
 * move to the database changed no answer a caller reads. "On this server"
 * stays: Phase 28 runs one API replica, and the job that holds the crawl is
 * that server's (render and rules run pinned to the API process that took the
 * call).
 */
export const busySentences = {
  /** `crawl_rules` while a rules run holds the crawl. */
  judging: (crawlId: string): string =>
    `crawl ${crawlId} is already being judged by this server: a rules run rewrites ` +
    `the crawl's issues, so two runs would leave the table holding half of each. ` +
    `Wait for the run in flight and read its summary, or ask again when it ends`,
  /** `crawl_render` while a render pass holds the crawl. */
  rendering: (crawlId: string): string =>
    `crawl ${crawlId}: a render pass is running for it on this server, and two ` +
    `passes may not share a crawl. Wait for crawl_render to answer, then ask again`,
  /**
   * Any other operation that would change the crawl under a render pass or a
   * rules run (`refuseWhileBusy`): resume, cancel, delete, a crawl config
   * change — and, since one job per crawl is now an index, a render pass under
   * a rules run and the reverse.
   */
  busy: (crawlId: string, operation: string, holder: "render" | "rules"): string =>
    `${operation} is refused for crawl ${crawlId}: ` +
    `${holder === "rules" ? "rules are running" : "a render pass is running"} on this ` +
    `server, and neither can be interrupted. Wait for it to answer, then ask again`,
  /** A judgement-only config change while rules run (`refuseWhileJudging`). */
  judgingConfig: (crawlId: string): string =>
    `rules are running for crawl ${crawlId}: its judgement cannot change under a run ` +
    "that has already read it. Wait for crawl_rules to answer, then set it again",
  /** `crawl_resume` of a crawl that already has a crawl job queued or running. */
  held: (crawlId: string, status: string): string =>
    `crawl ${crawlId} is already held by this server ('${status}'): it is ` +
    `running now or waiting to run, and a resume would be a second worker on ` +
    `the same crawl`,
} as const;

/**
 * A second live job for a crawl, refused. A `ServiceError` (CONFLICT) whose
 * sentence is the operation's own; `holder` says what holds the crawl, so a
 * caller that must answer in the crawl's terms (a rules run over a crawl that
 * is still crawling) can.
 */
export class JobBusyError extends ServiceError {
  constructor(
    readonly crawlId: string,
    readonly requested: JobKind,
    readonly holder: Pick<LiveJob, "kind" | "status">,
  ) {
    super("CONFLICT", busyMessage(crawlId, requested, holder));
    this.name = "JobBusyError";
  }
}

function busyMessage(crawlId: string, requested: JobKind, holder: Pick<LiveJob, "kind" | "status">): string {
  const operation = `crawl_${requested === "crawl" ? "resume" : requested}`;
  if (holder.kind === "crawl") {
    // A crawl job holds it: the crawl is queued or running. `crawl_rules` and
    // `crawl_render` answer in the crawl's terms (the service maps this one);
    // this is the sentence for a caller that does not.
    return requested === "crawl"
      ? busySentences.held(crawlId, holder.status)
      : `${operation} is refused for crawl ${crawlId}: its crawl job is ${holder.status}, ` +
          "and a crawl that has not stopped cannot be rendered or judged. Wait for it to stop, then ask again";
  }
  if (requested === holder.kind) {
    return requested === "rules" ? busySentences.judging(crawlId) : busySentences.rendering(crawlId);
  }
  return busySentences.busy(crawlId, operation, holder.kind);
}

/** The live-job unique violation, from drizzle's wrapped error or pg's own. */
function isLiveViolation(error: unknown): boolean {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      (e as { code?: unknown }).code === "23505" &&
      (e as { constraint?: unknown }).constraint === LIVE_INDEX,
  );
}

// ------------------------------------------------------------------- reading

/** The crawl's live job, or null. At most one exists (the index). */
export async function liveJobOf(reader: Reader, crawlId: string): Promise<LiveJob | null> {
  const rows = await reader
    .select({
      id: jobs.id,
      kind: jobs.kind,
      status: jobs.status,
      pinnedTo: jobs.pinnedTo,
      claimedBy: jobs.claimedBy,
    })
    .from(jobs)
    .where(and(eq(jobs.crawlId, crawlId), inArray(jobs.status, ["queued", "running"])));
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: readKind(row.kind, row.id),
    status: row.status === "queued" ? "queued" : row.status === "running" ? "running" : badStatus(row.status, row.id),
    pinnedTo: row.pinnedTo,
    claimedBy: row.claimedBy,
  };
}

/**
 * What `crawl_status.job` answers: the crawl's latest job — its live one when
 * it has one (a live job is always the latest: no job can be enqueued beside
 * it) — or null for a crawl no job ever ran (one older than 28b, or started
 * through the loop directly). `claimedBy` is present once a runner took it.
 */
export async function latestJobOf(
  reader: Reader,
  crawlId: string,
): Promise<{ kind: JobKind; status: JobStatus; claimedBy?: string } | null> {
  const rows = await reader
    .select({ id: jobs.id, kind: jobs.kind, status: jobs.status, claimedBy: jobs.claimedBy })
    .from(jobs)
    .where(eq(jobs.crawlId, crawlId))
    .orderBy(sql`${jobs.queuedAt} desc`, sql`${jobs.id} desc`)
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const status = JOB_STATUSES.find((s) => s === row.status) ?? badStatus(row.status, row.id);
  return {
    kind: readKind(row.kind, row.id),
    status,
    ...(row.claimedBy === null ? {} : { claimedBy: row.claimedBy }),
  };
}

/**
 * Where the crawl stands in its runner's queue: 0 when its crawl job is
 * running (the run is starting or under way), `1 + n` when it is queued behind
 * `n` crawl jobs of the same pool (the same `pinned_to`, so the queue of the
 * runner that will take it), and null when it has no live crawl job — nobody
 * will run it unless it is resumed.
 */
export async function queuePositionOf(reader: Reader, crawlId: string): Promise<number | null> {
  const result = await reader.execute<{ position: number }>(sql`
    select case when j.status = 'running' then 0
                else 1 + (select count(*)::int from jobs a
                          where a.kind = 'crawl' and a.status = 'queued'
                            and a.pinned_to is not distinct from j.pinned_to
                            and (a.queued_at, a.id) < (j.queued_at, j.id))
           end as position
    from jobs j
    where j.crawl_id = ${crawlId} and j.kind = 'crawl' and j.status in ('queued', 'running')`);
  const row = result.rows[0];
  return row === undefined ? null : Number(row.position);
}

function readKind(value: string, jobId: string): JobKind {
  const kind = JOB_KINDS.find((k) => k === value);
  if (kind === undefined) {
    throw new Error(`job ${jobId} has kind '${value}', which this engine never writes`);
  }
  return kind;
}

function badStatus(value: string, jobId: string): never {
  throw new Error(`job ${jobId} has status '${value}', which this engine never writes`);
}

// ------------------------------------------------------------------- writing

/**
 * Put a job in the queue: `queued`, stamped with this code's ruleset and
 * extraction versions, pinned to `pinnedTo` or to nobody. Inside the caller's
 * transaction when given one, so the job and the crawl change that asks for it
 * commit together. A crawl that already has a live job is refused with a
 * `JobBusyError` naming the operation (a savepoint keeps the caller's
 * transaction usable to read the holder).
 */
export async function enqueueJob(
  tx: Writer,
  input: { tenant: TenantId; crawlId: string; kind: JobKind; pinnedTo?: string },
): Promise<string> {
  const id = `job_${randomUUID()}`;
  await insertLive(tx, input.crawlId, input.kind, {
    id,
    tenantId: input.tenant,
    crawlId: input.crawlId,
    kind: input.kind,
    status: "queued",
    pinnedTo: input.pinnedTo ?? null,
    rulesetVersion: RULESET_VERSION,
    extractionVersion: EXTRACTION_VERSION,
  });
  return id;
}

async function insertLive(
  writer: Writer,
  crawlId: string,
  kind: JobKind,
  values: typeof jobs.$inferInsert,
): Promise<void> {
  try {
    await writer.transaction(async (savepoint) => {
      await savepoint.insert(jobs).values(values);
    });
  } catch (error) {
    if (!isLiveViolation(error)) throw error;
    const holder = await liveJobOf(writer, crawlId);
    if (holder === null) {
      // The holder ended between the refusal and this read: the crawl is free
      // now, but this call was refused and nothing was written.
      throw new ServiceError(
        "CONFLICT",
        `crawl ${crawlId} was held by another job when this call asked for it, and that job ` +
          "has just ended. Nothing was started: ask again",
      );
    }
    throw new JobBusyError(crawlId, kind, holder);
  }
}

/**
 * Claim the next job for a runner, or null when there is none: ONE statement,
 * so two runners racing for one job give it to exactly one.
 *
 * `FOR UPDATE SKIP LOCKED` in the sub-select is what makes it so: a runner
 * that finds the oldest queued row locked by another's claim skips it rather
 * than waiting and then re-claiming it. The claim takes the oldest eligible
 * job (`queued_at`, then `id`): queued, of one of `kinds`, pinned exactly as
 * `pinnedTo` asks, and enqueued by this code's ruleset and extraction
 * versions. Task 4 adds host and tenant eligibility here.
 *
 * A `crawl` job then does the loop's own compare-and-swap on `crawls.status`
 * (`queued → running`); a crawl paused or cancelled between this claim and
 * that one is a `ClaimLostError`, and the runner abandons the job having
 * written nothing (src/worker/crawl-job.ts).
 */
export async function claimNextJob(
  db: Writer,
  opts: { instanceId: string; kinds: readonly JobKind[]; pinnedTo: string | null },
): Promise<ClaimedJob | null> {
  if (opts.kinds.length === 0) throw new Error("claimNextJob: a runner must claim at least one kind");
  const pinned: SQL =
    opts.pinnedTo === null ? sql`pinned_to is null` : sql`pinned_to = ${opts.pinnedTo}`;
  const result = await db.execute<{
    id: string;
    tenant_id: string;
    crawl_id: string;
    kind: string;
    pinned_to: string | null;
    claimed_by: string;
    claimed_at: Date | string;
  }>(sql`
    update jobs
       set status = 'running', claimed_by = ${opts.instanceId},
           claimed_at = now(), heartbeat_at = now()
     where id = (
       select id from jobs
        where status = 'queued'
          and kind in (${sql.join(opts.kinds.map((k) => sql`${k}`), sql`, `)})
          and ${pinned}
          and ruleset_version = ${RULESET_VERSION}
          and extraction_version = ${EXTRACTION_VERSION}
        order by queued_at, id
        for update skip locked
        limit 1)
       and status = 'queued'
    returning id, tenant_id, crawl_id, kind, pinned_to, claimed_by, claimed_at`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    tenant: row.tenant_id as TenantId,
    crawlId: row.crawl_id,
    kind: readKind(row.kind, row.id),
    pinnedTo: row.pinned_to,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at instanceof Date ? row.claimed_at : new Date(row.claimed_at),
  };
}

/**
 * Settle a job: `done`, `failed` (with `error`, its first line, bounded) or
 * `abandoned`. A job already settled is left exactly as it stands — the
 * transaction that did its work settled it with the work (a crawl's close, a
 * pause of a queued crawl), or the reaper did, and that answer is the one
 * that describes it. A job that does not exist throws.
 */
export async function finishJob(
  db: Writer,
  jobId: string,
  outcome: JobOutcome,
  error?: string,
): Promise<void> {
  const moved = await db
    .update(jobs)
    .set({
      status: outcome,
      finishedAt: new Date(),
      error: outcome === "failed" ? jobError(error ?? "failed with no message") : null,
    })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["queued", "running"])))
    .returning({ id: jobs.id });
  if (moved.length > 0) return;
  const [exists] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
  if (exists === undefined) throw new Error(`finishJob: no job ${jobId}`);
}

/**
 * Settle a crawl's live crawl job inside the transaction of the crawl change
 * that ends it, so no reader ever sees the crawl stopped and its job still
 * holding it: the loop's close (`ResumeOpts.onClose`), a pause or cancel of a
 * queued crawl. Only a job in `statuses` moves — a pause of a queued crawl
 * abandons a QUEUED job and leaves a claimed one to the runner that holds it.
 */
export async function settleCrawlJob(
  tx: Writer,
  crawlId: string,
  outcome: JobOutcome,
  statuses: readonly ("queued" | "running")[],
  error?: string,
): Promise<void> {
  await tx
    .update(jobs)
    .set({
      status: outcome,
      finishedAt: new Date(),
      error: outcome === "failed" ? jobError(error ?? "failed with no message") : null,
    })
    .where(
      and(eq(jobs.crawlId, crawlId), eq(jobs.kind, "crawl"), inArray(jobs.status, [...statuses])),
    );
}

/**
 * Run `run` under a `running` job pinned to `instanceId` — the synchronous
 * `crawl_render` and `crawl_rules` calls (spec item 6). The insert is the busy
 * guard: a crawl that already has a live job refuses with `JobBusyError`, and
 * `run` is never called. The job is `done` when `run` resolves and `failed`
 * (with the error's first line) when it throws; the error is rethrown.
 *
 * It replaced the `judging` and `rendering` sets: the hold is now a row every
 * process over the database can see, and the reaper (Task 4) can tell a dead
 * holder's from a live one.
 */
export async function withPinnedJob<T>(
  db: Db,
  input: { tenant: TenantId; crawlId: string; kind: "render" | "rules"; instanceId: string },
  run: () => Promise<T>,
): Promise<T> {
  const id = `job_${randomUUID()}`;
  const now = new Date();
  await insertLive(db, input.crawlId, input.kind, {
    id,
    tenantId: input.tenant,
    crawlId: input.crawlId,
    kind: input.kind,
    status: "running",
    pinnedTo: input.instanceId,
    claimedBy: input.instanceId,
    claimedAt: now,
    heartbeatAt: now,
    rulesetVersion: RULESET_VERSION,
    extractionVersion: EXTRACTION_VERSION,
  });
  let result: T;
  try {
    result = await run();
  } catch (error) {
    try {
      await finishJob(db, id, "failed", messageOf(error));
    } catch (finishError) {
      // Both, never one in place of the other (rule 7).
      throw new AggregateError(
        [error, finishError],
        `crawl ${input.crawlId}: the ${input.kind} run failed, and settling its job failed too`,
      );
    }
    throw error;
  }
  await finishJob(db, id, "done");
  return result;
}

/** A job's `error`: the first line of a message, bounded. Never a stack. */
export function jobError(message: string): string {
  const first = message.split("\n", 1)[0] ?? "";
  const line = first.trim() === "" ? "failed with no message" : first.trim();
  return line.length > 500 ? `${line.slice(0, 497)}...` : line;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
 *
 * ## Fair claims (Task 4a)
 *
 * A claim takes the oldest job that is also ELIGIBLE:
 *
 *  - **One fetcher per host, every claim.** A `crawl` or `render` job is not
 *    claimed while a `running` crawl or render job exists for a crawl with the
 *    same `crawls.host_key` (hard rule 9: two crawls of one site would each
 *    obey their own per-host delay and together break it). Pinned or not: an
 *    in-process service's crawl and a worker's are the same load on the site.
 *    A `rules` job fetches nothing and is never held by a host.
 *  - **A per-tenant cap, the unpinned pool only (R9).** An unpinned `crawl`
 *    job is not claimed while its tenant has `maxRunningPerTenant` unpinned
 *    crawl jobs running, so one tenant's backlog cannot hold every worker. A
 *    pinned claim belongs to the one process that accepted the crawl and runs
 *    as that process decides; its running jobs are not the pool's and do not
 *    count against the cap.
 *
 * "Running" is the row's status, whoever holds it: a job whose process died is
 * still running until the reaper (Task 4b) settles it, and its host stays held
 * till then — never a second fetcher on a site because a heartbeat was late.
 *
 * **The claims take turns.** Under READ COMMITTED two claims racing over two
 * queued jobs of ONE host each see the other's job still queued (neither
 * update has committed), so `SKIP LOCKED` alone — which only stops two claims
 * of one ROW — would start both. Every claim that can start a fetch, and every
 * synchronous render's start, therefore takes one transaction-level advisory
 * lock (`HOST_CLAIM_LOCK`) before its statement: the next one's statement sees
 * the last one's committed claim. A claim is one indexed statement held for
 * milliseconds, so the turns cost nothing a caller can see.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { ServiceError } from "../api/errors.js";
import { EXTRACTION_VERSION } from "../crawl/versions.js";
import { RULESET_VERSION } from "../rules/registry/registry.js";
import { DEFAULT_TIMING } from "./timing.js";
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
  /** Whether the process holding it is live (`liveHolderSql`). */
  live: boolean;
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
  /**
   * `crawl_render` while another crawl's crawl or render job fetches the same
   * host (`HOST_BUSY`, 28b T4a). Names the caller's own crawl and its host key
   * only: the job holding the host may be another tenant's, and a foreign
   * crawl is never named (28a).
   */
  hostBusy: (crawlId: string, hostKey: string): string =>
    `crawl_render is refused for crawl ${crawlId}: ${hostKey} is being crawled or rendered ` +
    "by another job, and two at once would together break the site's politeness limits. " +
    "Wait for it to end, then ask again",
  /**
   * `crawl_resume` / `crawl_mark_failed` whose orphan job moved between the
   * read and the write (`abandonOrphanJob`): a live engine process claimed
   * it, or another call settled it first. The caller's own crawl only; who
   * moved it is not named.
   */
  orphanClaimed: (crawlId: string, operation: "crawl_resume" | "crawl_mark_failed"): string =>
    `${operation} is refused for crawl ${crawlId}: its crawl job changed while this call ` +
    "was being checked — a live engine process claimed it, or another call settled it " +
    "first. Nothing was changed; read crawl_status and try again",
} as const;

/**
 * The transaction-level advisory lock every fetching claim and every
 * synchronous render's start takes before reading host eligibility (module
 * header, "the claims take turns"). One key for the whole engine.
 */
export const HOST_CLAIM_LOCK = 2_028_004_001;

/** The job kinds that fetch from the site, and so hold its host while running. */
const FETCHING_KINDS: readonly JobKind[] = ["crawl", "render"];

async function takeHostClaimLock(tx: Writer): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${HOST_CLAIM_LOCK}::bigint)`);
}

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

/**
 * WHETHER A LIVE JOB IS HELD (Ruling R10): a `queued|running` job counts as
 * somebody's work only while the process it belongs to is LIVE — the
 * instance that claimed it (`running`) or the one it is pinned to (`queued`):
 * not stopped (`instances.stopped_at`, set by a graceful shutdown) and a
 * heartbeat within `deadAfterMs`, on the database's clock. An unpinned queued
 * job belongs to the worker pool, which no single instance stands for, and is
 * held — when it was enqueued by THIS code's ruleset and extraction versions
 * (28b T4a). One of another version is claimed only by a runner of that
 * version, and the process asking cannot see one: on a rolling deploy whose
 * old runners are gone none is left, so it is read as nobody's, like a dead
 * process's job. A job whose process is gone is a row, not work: its queued
 * crawl is nobody's (`queuePosition` null), `crawl_mark_failed` may retire it
 * and `crawl_resume` adopts it (a fresh job, stamped with this code's
 * versions). (Task 4's reaper settles such rows; until it runs they are read
 * as what they are.) A SQL boolean over the job alias `j`.
 */
export function liveHolderSql(deadAfterMs: number): SQL {
  if (!Number.isInteger(deadAfterMs) || deadAfterMs <= 0) {
    throw new Error(`liveHolderSql: deadAfterMs must be a positive whole number, got ${String(deadAfterMs)}`);
  }
  return sql`(
    (j.status = 'queued' and j.pinned_to is null
       and j.ruleset_version = ${RULESET_VERSION} and j.extraction_version = ${EXTRACTION_VERSION})
    or exists (
      select 1 from instances i
       where i.id = (case when j.status = 'running' then j.claimed_by else j.pinned_to end)
         and i.stopped_at is null
         and i.heartbeat_at > now() - (${deadAfterMs}::int * interval '1 millisecond')))`;
}

/**
 * The crawl's live (`queued|running`) job, or null — at most one exists (the
 * index) — with whether its holder is live (`liveHolderSql`). The busy guards
 * read the row whatever its holder: the index refuses a second job either way.
 * The "held" questions (`queuePosition`, `crawl_mark_failed`, `crawl_resume`)
 * read `live`.
 */
export async function liveJobOf(
  reader: Reader,
  crawlId: string,
  deadAfterMs: number = DEFAULT_TIMING.deadAfter,
): Promise<LiveJob | null> {
  const result = await reader.execute<{
    id: string;
    kind: string;
    status: string;
    pinned_to: string | null;
    claimed_by: string | null;
    live: boolean;
  }>(sql`
    select j.id, j.kind, j.status, j.pinned_to, j.claimed_by, ${liveHolderSql(deadAfterMs)} as live
      from jobs j
     where j.crawl_id = ${crawlId} and j.status in ('queued', 'running')`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: readKind(row.kind, row.id),
    status: row.status === "queued" ? "queued" : row.status === "running" ? "running" : badStatus(row.status, row.id),
    pinnedTo: row.pinned_to,
    claimedBy: row.claimed_by,
    live: row.live === true,
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
 * Where the crawl stands in its tenant's queue (R12):
 *
 *  - 0 when its crawl job is running (the run is starting or under way);
 *  - `1 + n` when it is queued behind `n` crawl jobs OF ITS OWN TENANT in the
 *    same runner's queue — the same pool (`pinned_to`) and the same engine
 *    versions, since a runner claims only its own versions. Other tenants'
 *    crawls are never counted: how much work another tenant has queued is not
 *    the caller's to learn (the automated security review on 28a's tenancy);
 *  - null when it is not positioned: no crawl job a live process holds
 *    (`liveHolderSql`) — nobody will run it unless it is resumed. That
 *    includes an unpinned queued job enqueued by ANOTHER engine version than
 *    this code's: only a runner of that version claims it, and on a rolling
 *    deploy whose old runners are gone none is left, so a position would read
 *    as "waiting" forever. (A pinned job's holder is the process that enqueued
 *    it, of its own version, and is positioned as ever.)
 *
 * The position is an order, not a promise: a crawl whose host is busy, or
 * whose tenant is at its cap, waits while jobs behind it of other hosts or
 * tenants are claimed (`claimNextJob`).
 */
export async function queuePositionOf(
  reader: Reader,
  crawlId: string,
  deadAfterMs: number,
): Promise<number | null> {
  const result = await reader.execute<{ position: number }>(sql`
    select case when j.status = 'running' then 0
                else 1 + (select count(*)::int from jobs a
                          where a.tenant_id = j.tenant_id and a.status = 'queued' and a.kind = 'crawl'
                            and a.pinned_to is not distinct from j.pinned_to
                            and a.ruleset_version = j.ruleset_version
                            and a.extraction_version = j.extraction_version
                            and (a.queued_at, a.id) < (j.queued_at, j.id))
           end as position
    from jobs j
    where j.crawl_id = ${crawlId} and j.kind = 'crawl' and j.status in ('queued', 'running')
      and ${liveHolderSql(deadAfterMs)}`);
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
 * `pinnedTo` asks, enqueued by this code's ruleset and extraction versions,
 * and fair (module header, "Fair claims"): no running crawl or render job on
 * its host, and — unpinned only — its tenant under `maxRunningPerTenant`.
 *
 * The eligibility reads only RUNNING jobs, a set bounded by the engine's
 * total concurrency, through `jobs_running_kind_tenant` (each read once per
 * statement, as a materialised CTE); the candidates walk `jobs_claim_order`
 * and join their crawl by primary key. A claim that can start a fetch takes
 * `HOST_CLAIM_LOCK` first, in the same transaction (module header).
 *
 * `maxRunningPerTenant`: required for an unpinned claim (a positive whole
 * number, `parseTenantMaxRunning` reads it from `ARIADNE_TENANT_MAX_RUNNING`),
 * refused for a pinned one, which the cap does not apply to (R9).
 *
 * A `crawl` job then does the loop's own compare-and-swap on `crawls.status`
 * (`queued → running`); a crawl paused or cancelled between this claim and
 * that one is a `ClaimLostError`, and the runner abandons the job having
 * written nothing (src/worker/crawl-job.ts).
 */
export async function claimNextJob(
  db: Writer,
  opts: { instanceId: string; kinds: readonly JobKind[]; pinnedTo: string | null; maxRunningPerTenant?: number },
): Promise<ClaimedJob | null> {
  if (opts.kinds.length === 0) throw new Error("claimNextJob: a runner must claim at least one kind");
  assertTenantCap(opts.pinnedTo, opts.maxRunningPerTenant, "claimNextJob");
  const pinned: SQL =
    opts.pinnedTo === null ? sql`q.pinned_to is null` : sql`q.pinned_to = ${opts.pinnedTo}`;
  const kinds = sql.join(opts.kinds.map((k) => sql`${k}`), sql`, `);
  // The tenant cap: the pool's running crawl jobs per tenant (R9). Pinned
  // claims neither read nor feed it.
  const unpinned = opts.pinnedTo === null;
  const tenantRunning: SQL = unpinned
    ? sql`, tenant_running as materialized (
          select r.tenant_id, count(*)::int as n
            from jobs r
           where r.status = 'running' and r.kind = 'crawl' and r.pinned_to is null
           group by r.tenant_id)`
    : sql``;
  const underCap: SQL = unpinned
    ? sql`and (q.kind <> 'crawl' or not exists (
            select 1 from tenant_running t
             where t.tenant_id = q.tenant_id and t.n >= ${opts.maxRunningPerTenant}::int))`
    : sql``;
  const statement = sql`
    with busy_hosts as materialized (
      select distinct c.host_key
        from jobs r join crawls c on c.id = r.crawl_id
       where r.status = 'running' and r.kind in ('crawl', 'render'))
      ${tenantRunning}
    update jobs
       set status = 'running', claimed_by = ${opts.instanceId},
           claimed_at = now(), heartbeat_at = now()
     where id = (
       select q.id from jobs q join crawls qc on qc.id = q.crawl_id
        where q.status = 'queued'
          and q.kind in (${kinds})
          and ${pinned}
          and q.ruleset_version = ${RULESET_VERSION}
          and q.extraction_version = ${EXTRACTION_VERSION}
          and (q.kind not in ('crawl', 'render')
               or not exists (select 1 from busy_hosts b where b.host_key = qc.host_key))
          ${underCap}
        order by q.queued_at, q.id
        for update of q skip locked
        limit 1)
       and status = 'queued'
    returning id, tenant_id, crawl_id, kind, pinned_to, claimed_by, claimed_at`;
  type Row = {
    id: string;
    tenant_id: string;
    crawl_id: string;
    kind: string;
    pinned_to: string | null;
    claimed_by: string;
    claimed_at: Date | string;
  };
  const fetches = opts.kinds.some((k) => FETCHING_KINDS.includes(k));
  const result = fetches
    ? await db.transaction(async (tx) => {
        await takeHostClaimLock(tx);
        return tx.execute<Row>(statement);
      })
    : await db.execute<Row>(statement);
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
 * Abandon an orphan job (one `liveJobOf` read as not held) ONLY if it still
 * stands as it was read: the same status, and — running — the same claimer.
 * True when it moved. `crawl_resume`'s adoption and `crawl_mark_failed` use it
 * inside their transaction, after the reads that called the job an orphan.
 *
 * Why not `finishJob`: that settles `queued` or `running` alike, and between
 * the read and the settle a runner may have claimed the job — an old-version
 * runner during a rolling deploy claims exactly the unpinned job this code
 * reads as nobody's. Abandoning a job that is now running leaves the runner
 * crawling under an `abandoned` row: `busy_hosts` no longer sees its host
 * (hard rule 9) and `crawl_status.job` misreports it. A job that moved is the
 * caller's refusal, never a settle.
 */
export async function abandonOrphanJob(
  tx: Writer,
  job: Pick<LiveJob, "id" | "status" | "claimedBy">,
): Promise<boolean> {
  const moved = await tx
    .update(jobs)
    .set({ status: "abandoned", finishedAt: new Date(), error: null })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, job.status),
        job.claimedBy === null ? isNull(jobs.claimedBy) : eq(jobs.claimedBy, job.claimedBy),
      ),
    )
    .returning({ id: jobs.id });
  return moved.length > 0;
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
 *
 * A `render` job fetches, so it is also a claim on its host (28b T4a): under
 * `HOST_CLAIM_LOCK`, the insert first (the crawl's own busy guard keeps its
 * sentence), then the host — a running crawl or render job of ANOTHER crawl
 * with the same `host_key` refuses `HOST_BUSY` and the insert rolls back.
 * A `rules` job fetches nothing and is inserted as before.
 */
export async function withPinnedJob<T>(
  db: Db,
  input: { tenant: TenantId; crawlId: string; kind: "render" | "rules"; instanceId: string },
  run: () => Promise<T>,
): Promise<T> {
  const id = `job_${randomUUID()}`;
  const now = new Date();
  const values: typeof jobs.$inferInsert = {
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
  };
  if (input.kind === "render") {
    await db.transaction(async (tx) => {
      await takeHostClaimLock(tx);
      await insertLive(tx, input.crawlId, input.kind, values);
      await refuseBusyHost(tx, input.crawlId);
    });
  } else {
    await insertLive(db, input.crawlId, input.kind, values);
  }
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

/**
 * `HOST_BUSY` when a running crawl or render job of another crawl holds this
 * crawl's host. Called under `HOST_CLAIM_LOCK`, so no claim of that host can
 * land between this read and the caller's commit.
 */
async function refuseBusyHost(tx: Writer, crawlId: string): Promise<void> {
  const result = await tx.execute<{ host_key: string; busy: boolean }>(sql`
    select c.host_key,
           exists (select 1 from jobs r join crawls rc on rc.id = r.crawl_id
                    where r.status = 'running' and r.kind in ('crawl', 'render')
                      and rc.host_key = c.host_key and r.crawl_id <> c.id) as busy
      from crawls c
     where c.id = ${crawlId}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`refuseBusyHost: no crawl ${crawlId}`);
  if (row.busy === true) throw new ServiceError("HOST_BUSY", busySentences.hostBusy(crawlId, row.host_key));
}

/**
 * The per-tenant cap's contract (R9): an unpinned claim names it, a positive
 * whole number; a pinned one does not, because the cap is not applied to it.
 */
export function assertTenantCap(pinnedTo: string | null, maxRunningPerTenant: number | undefined, where: string): void {
  if (pinnedTo !== null) {
    if (maxRunningPerTenant !== undefined) {
      throw new Error(
        `${where}: maxRunningPerTenant applies only to the unpinned pool; a claim pinned to ` +
          `${pinnedTo} is not capped per tenant`,
      );
    }
    return;
  }
  if (maxRunningPerTenant === undefined || !Number.isInteger(maxRunningPerTenant) || maxRunningPerTenant < 1) {
    throw new Error(
      `${where}: an unpinned claim needs maxRunningPerTenant, a positive whole number ` +
        `(ARIADNE_TENANT_MAX_RUNNING), got ${String(maxRunningPerTenant)}`,
    );
  }
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

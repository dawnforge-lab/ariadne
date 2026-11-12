/**
 * Running one claimed `crawl` job (Phase 28b): what the API service's queue
 * runner did before 28b (`runQueued`), now the `execute` of any `JobRunner`
 * over crawl jobs — the in-process service's, or a worker's.
 *
 * `resumeCrawl` rather than `runCrawl` because the row already exists — it
 * was created when the crawl was accepted. A queued crawl's frontier is empty,
 * so a resume of it does exactly what a fresh run does: discover, seed, loop.
 * A resumed crawl differs only in that its frontier is not empty.
 *
 * THE CONFIG IS READ HERE, AT CLAIM, from the row — not carried from
 * acceptance — so a change made while the crawl waited is the one it runs
 * with. The two test-only fields the row never holds (`storableConfig`) are
 * re-asserted from the process (`processTrust`), never from a row or a request.
 *
 * THE CRAWL MAY HAVE LEFT `queued` WHILE IT WAITED: paused or cancelled by an
 * agent, retired by `crawl_mark_failed`. A pause or cancel of a queued crawl
 * abandons its job in the same transaction, so a runner never claims one that
 * was decided first; one decided in the instant after the claim is seen here
 * (the read) or by the loop's compare-and-swap (`expectStatus: "queued"`).
 * Both are the same `ClaimLostError`: logged, the job abandoned, and the row
 * left exactly as the other writer left it — closing it `failed` would
 * overwrite a decision somebody made.
 *
 * THE ALLOWLIST IS RE-CHECKED HERE, WHERE THE CRAWL RUNS (28b T5). A crawl is
 * accepted by one process and may run on another — a worker with an allowlist
 * of its own (`ARIADNE_ALLOWED_DOMAINS`) — so a runner checks the site, every
 * `legacyHosts` entry and every `sitemapUrls` entry against ITS allowlist
 * before the loop starts (`crawlAllowlistRefusal`). A refusal closes the crawl
 * `paused` (`not_allowed`) and settles the job in one transaction, exactly as
 * the unreadable-credentials pause does, with nothing fetched. It is not a
 * system pause: no reaper requeues it, and `crawl_resume` re-checks at the API.
 *
 * THE JOB MAY BE TAKEN FROM THE RUNNER (28b T4b): a reaper that read its
 * process as dead abandons it, `crawl_resume` adopts it. Every write here and
 * in the loop is conditioned on the job still being this runner's
 * (`ResumeOpts.owner`): a job taken before the crawl's claim never starts it,
 * and one taken during the run — the runner's heartbeat aborts it then — does
 * not close the crawl over whoever took it (`JobLostError`, logged).
 *
 * EVERY END SETTLES THE JOB WITH THE CRAWL CHANGE THAT ENDS IT, in one
 * transaction where the crawl changes: the loop's close (`onClose`), the
 * `credentials_unreadable` pause. So no reader sees the crawl stopped while its
 * job still holds it — a `crawl_rules` called the moment a crawl reads
 * `finished` is not refused because its job had not caught up.
 *
 * `reclaimLeases` is not passed: it would hand every live lease in the crawl
 * back to pending, which is right after a crash and wrong while another
 * process is working, and a runner cannot tell those apart from outside.
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { crawls, jobs } from "../db/schema.js";
import {
  ClaimLostError,
  failureReasonOf,
  JobLostError,
  lockRunOwnership,
  parseStoredConfig,
  resumeCrawl,
  type CloseHook,
  type CrawlConfig,
} from "../crawl/loop.js";
import { hostProbeStarts } from "../crawl/parse/url-utils.js";
import { describeShape, sameShape, shapeOf, type CrawlCredentials, type CredentialShape } from "../crawl/credentials.js";
import type { CredentialRead, CredentialVault } from "../crawl/credential-vault.js";
import { readScheduleChain } from "../crawl/insert-crawl.js";
import type { TenantId } from "../tenant.js";
import { enqueueJob, finishJob, type ClaimedJob, type JobOutcome } from "./jobs.js";

export interface CrawlJobDeps {
  db: Db;
  vault: CredentialVault;
  /**
   * This process's crawl allowlist, as the question the claim asks: may a
   * fetch be pointed at this host (`isHostAllowed` over the process's
   * `ARIADNE_ALLOWED_DOMAINS`; the API service's gate in-process). Required:
   * a runner with no answer would run what it was handed.
   */
  hostAllowed: (host: string) => boolean;
  /** `allowPrivate` / `recheckMinGapMs`: the process-trust seam, code only. */
  processTrust: Pick<CrawlConfig, "allowPrivate" | "recheckMinGapMs">;
  log: (line: string) => void;
  /** The log lines' prefix: `api` in the API service, `worker` in a worker. */
  logPrefix?: string;
}

/**
 * How a crawl job ends, given how its crawl closed: `failed` with the crawl;
 * `abandoned` when the process stopped under it (a `shutdown` pause — the
 * crawl is resumable, and its work was not finished by this job); `done` for
 * every other close, an agent's pause and cancel included (the job did what
 * was asked of it).
 */
export function crawlJobOutcome(closed: Parameters<CloseHook>[1]): JobOutcome {
  if (closed.status === "failed") return "failed";
  if (closed.status === "paused" && closed.pauseReason === "shutdown") return "abandoned";
  return "done";
}

/**
 * The loop's close hook for one job: settle it in the close's transaction —
 * and, on a `finished` close of a crawl a schedule fired (`schedule_chain`
 * non-null, 28c), enqueue the chain's first link in that same transaction:
 * `render` when the chain renders, `rules` otherwise, pinned as the crawl job
 * was (`pinnedTo`, call C4). One transaction, so no reader sees the crawl
 * finished with neither its crawl job nor its first link live — the
 * scheduler's overlap read, above all, which would fire the next crawl into
 * that gap. The crawl job is settled first: a crawl has one live job at a time.
 *
 * Any other close — paused, cancelled, failed — enqueues nothing: a chain
 * judges a crawl that finished, and nothing else. A chain this engine never
 * wrote throws, and the close rolls back with it (the run fails loudly).
 */
export function crawlJobCloseHook(jobId: string, pinnedTo: string | null): CloseHook {
  return async (tx, closed) => {
    await finishJob(tx, jobId, crawlJobOutcome(closed), closed.failureReason ?? undefined);
    if (closed.status !== "finished") return;
    const [row] = await tx
      .select({ crawlId: crawls.id, tenant: crawls.tenantId, chain: crawls.scheduleChain })
      .from(jobs)
      .innerJoin(crawls, eq(crawls.id, jobs.crawlId))
      .where(eq(jobs.id, jobId));
    if (row === undefined) throw new Error(`crawl job ${jobId}: at its crawl's close, no such job or crawl`);
    if (row.chain === null) return;
    const chain = readScheduleChain(row.chain, row.crawlId);
    await enqueueJob(tx, {
      tenant: row.tenant as TenantId,
      crawlId: row.crawlId,
      kind: chain.render === null ? "rules" : "render",
      ...(pinnedTo === null ? {} : { pinnedTo }),
    });
  };
}

/**
 * A vault read, for a crawl whose row names `required`: the values, or why
 * there are none this process can use, as a phrase an answer can carry (no
 * value, no key). An unreadable copy is logged with its reason, once per read.
 * A readable copy of another shape than the row's is our defect — both are
 * written in one transaction — and throws, naming the shapes only.
 */
export function storedCredentialsOf(
  crawlId: string,
  required: CredentialShape,
  read: CredentialRead,
  log: (line: string) => void,
  logPrefix = "api",
): { kind: "ok"; credentials: CrawlCredentials } | { kind: "missing"; why: string } {
  switch (read.kind) {
    case "none":
      return { kind: "missing", why: "this server has no stored copy of them" };
    case "unreadable":
      log(`${logPrefix}: crawl ${crawlId}: its stored credentials cannot be read (${read.reason})`);
      return {
        kind: "missing",
        why:
          read.reason === "unknown-key"
            ? "the stored copy was encrypted under a key this server does not hold"
            : "the stored copy does not authenticate under this server's keys",
      };
    case "ok": {
      const found = shapeOf(read.credentials);
      if (!sameShape(found, required)) {
        throw new Error(
          `crawl ${crawlId}: its stored credentials are ${found === null ? "empty" : describeShape(found)}, ` +
            `and its row names ${describeShape(required)}; the two are written together, so this ` +
            "is a defect, not a request to fix",
        );
      }
      return { kind: "ok", credentials: read.credentials };
    }
  }
}

/**
 * Why this process may not run a crawl, or null when it may: the site's host,
 * each `legacyHosts` host and each `sitemapUrls` host must satisfy
 * `hostAllowed`, except the site's own spellings (apex/www x http/https,
 * `hostProbeStarts`), which the site's own entry authorises as it does at the
 * API. The hosts are named, the allowlist never is (obligation 6). A row this
 * engine did not write (an unreadable URL or host) throws: that is a defect,
 * never a quiet pass.
 */
export function crawlAllowlistRefusal(
  config: Pick<CrawlConfig, "siteUrl" | "legacyHosts" | "sitemapUrls">,
  hostAllowed: (host: string) => boolean,
): string | null {
  const siteHost = new URL(config.siteUrl).hostname;
  if (!hostAllowed(siteHost)) return `siteUrl is on '${siteHost}', which is not in this process's crawl allowlist`;
  const own = new Set(hostProbeStarts(config.siteUrl).map((start) => new URL(start).hostname));
  const added = (field: string, hosts: readonly string[]): string | null => {
    for (const host of hosts) {
      if (own.has(host)) continue;
      if (!hostAllowed(host)) return `${field} names '${host}', which is not in this process's crawl allowlist`;
    }
    return null;
  };
  const legacy = (config.legacyHosts ?? []).length === 0 ? [] : hostProbeStarts(config.siteUrl, config.legacyHosts);
  const refused = added("legacyHosts", legacy.map((start) => new URL(start).hostname));
  if (refused !== null) return refused;
  return added(
    "sitemapUrls",
    (config.sitemapUrls ?? []).map((entry) => new URL(entry).hostname),
  );
}

/** The `execute` of a runner over `crawl` jobs. */
export function crawlJobExecutor(deps: CrawlJobDeps): (job: ClaimedJob, signal: AbortSignal) => Promise<void> {
  return (job, signal) => runCrawlJob(deps, job, signal);
}

async function runCrawlJob(deps: CrawlJobDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const { db, vault, log } = deps;
  const p = deps.logPrefix ?? "api";
  const crawlId = job.crawlId;
  try {
    // THE ROW AND ITS CREDENTIALS FROM ONE SNAPSHOT (28b). Both are written in
    // one transaction by every change (`credential_generation` counts them),
    // so a repeatable-read pair is a config and the values written with it.
    const { row, read } = await db.transaction(
      async (tx) => {
        const [found] = await tx
          .select({ status: crawls.status, config: crawls.config, pagesCrawled: crawls.pagesCrawled })
          .from(crawls)
          .where(eq(crawls.id, crawlId));
        return { row: found, read: found === undefined ? null : await vault.read(crawlId, tx) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (row === undefined || read === null) throw new Error(`queue runner: no crawl ${crawlId}`);
    if (row.status !== "queued") throw new ClaimLostError(crawlId, row.status, "queued");
    const parsed = parseStoredConfig(row.config, crawlId);
    // BEFORE the credentials are read and before anything is fetched.
    const refusal = crawlAllowlistRefusal(parsed, deps.hostAllowed);
    if (refusal !== null) {
      await pauseBeforeStart(deps, job, "not_allowed", refusal);
      return;
    }
    const required = parsed.credentialShape ?? null;
    let credentials: CrawlCredentials | undefined;
    if (required === null) {
      // A crawl with no credentials has no stored copy: one would be a write
      // this engine never makes, and it is not run on a guess.
      if (read.kind !== "none") {
        throw new Error(
          `queue runner: crawl ${crawlId} names no credentials and has a stored copy; ` +
            "the two are written together, so this is a defect",
        );
      }
    } else {
      const stored = storedCredentialsOf(crawlId, required, read, log, p);
      if (stored.kind === "missing") {
        // NOT RUN, AND NOT FAILED: paused, before a single request, until the
        // values are sent again (28b item 10). The loop would refuse the crawl
        // too (`requireCredentials`), but as `failed` — and a crawl whose site
        // never saw a request did not fail.
        await pauseBeforeStart(deps, job, "credentials_unreadable", stored.why);
        return;
      }
      credentials = stored.credentials;
    }
    const config: CrawlConfig = {
      ...parsed,
      ...deps.processTrust,
      ...(credentials === undefined ? {} : { credentials }),
    };
    // "starting" against a row that already holds pages would be a small lie
    // that costs an operator an hour: a crawl that has run before resumes.
    log(`${p}: crawl ${crawlId} ${row.pagesCrawled > 0 ? "resuming" : "starting"} (${config.siteUrl})`);
    const summary = await resumeCrawl(db, crawlId, {
      config,
      signal,
      expectStatus: "queued",
      // The close settles the job — and, for a fired crawl that finished,
      // enqueues its chain's first link with this job's pin (C4).
      onClose: crawlJobCloseHook(job.id, job.pinnedTo),
      // The run writes the crawl only while this job is still its own (28b
      // T4b): a job abandoned by a reaper or adopted by a resume never starts
      // the crawl, and its close is not written over the crawl's new holder.
      owner: { jobId: job.id, instanceId: job.claimedBy },
    });
    // A run that ended cancelled (an agent's cancel of a running crawl)
    // releases its credentials, as a cancel of a queued or paused one does
    // (Deviation 9). A finished crawl keeps them: a render pass needs them.
    if (summary.status === "cancelled") await vault.remove(db, crawlId);
    // The template inference beside the page count: the pair is the whole of
    // "what shape is this site". Null only when the pass did not run, and
    // that is said in those words rather than printed as a zero.
    const templates =
      summary.pageTemplates === null
        ? "page types not inferred"
        : `${summary.pageTemplates.typesBefore} URL shape(s) -> ` +
          `${summary.pageTemplates.typesAfter} page type(s), ` +
          `${summary.pageTemplates.pagesRetyped} retyped`;
    log(`${p}: crawl ${crawlId} ${summary.status} — ${summary.pagesCrawled} page(s), ${templates}`);
  } catch (error) {
    if (error instanceof JobLostError) {
      // The job was taken from this runner (a reaper, a resume's adoption):
      // the crawl is whoever took it's, and nothing was written to it. The
      // job is already settled; `finishJob` leaves it so.
      log(
        error.stage === "start"
          ? `${p}: crawl ${crawlId}: its job ${job.id} was taken from this runner before the crawl ` +
              "started; not started"
          : `${p}: crawl ${crawlId}: its job ${job.id} was taken from this runner, and the crawl ` +
              `('${error.status}') by another holder since; this run's close was not written`,
      );
      await finishJob(db, job.id, "abandoned");
      return;
    }
    if (error instanceof ClaimLostError) {
      // Not a failure, and nothing to write to the crawl: see the module
      // header. Matched on the type, never on the sentence.
      log(`${p}: crawl ${crawlId} left the queue state ('${error.status}') before it ran; not started`);
      await finishJob(db, job.id, "abandoned");
      return;
    }
    // The loop's own failure path has already closed the row `failed` (and
    // its job with it) for anything thrown inside the run. A throw BEFORE that
    // — a row deleted underneath, a config the loop will not take, a database
    // that refused the claim — would leave the row `queued` with nobody to
    // run it, which is a lie: it is closed here, and the row says why
    // (migration 0017). The `where` keeps the two writers from arguing: a row
    // the loop already closed is no longer `queued` and keeps its own reason.
    //
    // ONE TRANSACTION with the job's settle (28b T4b fix round 1), through the
    // same handle as the run it records, so a database that refused the run
    // refuses the record too and says so (http.test's "cannot even record its
    // own failure"). And only while the job is still this runner's, read as
    // the start claim reads it — the crawl row locked, then the job row
    // (`lockRunOwnership`): a crawl adopted meanwhile is queued under ANOTHER
    // job, and is not ours to fail. A job no longer ours is settled already,
    // and `finishJob` leaves it so.
    log(`${p}: crawl ${crawlId} threw — ${messageOf(error)}`);
    try {
      await db.transaction(async (tx) => {
        const run = await lockRunOwnership(tx, crawlId, { jobId: job.id, instanceId: job.claimedBy });
        if (run.owned && run.status === "queued") {
          await tx
            .update(crawls)
            .set({
              status: "failed",
              finishedAt: new Date(),
              // The loop's own helper: one rule for what may go in this column.
              failureReason: failureReasonOf(error),
            })
            .where(and(eq(crawls.id, crawlId), eq(crawls.status, "queued")));
        }
        await finishJob(tx, job.id, "failed", failureReasonOf(error));
      });
    } catch (recordError) {
      log(
        `${p}: crawl ${crawlId} (job ${job.id}) — the queue runner itself failed and could not ` +
          `record it, so the job is left as it was: ` +
          messageOf(recordError),
      );
      throw recordError;
    }
  }
}

/**
 * Close a queued crawl `paused` with `pause_reason = reason`, and settle its
 * job, in one transaction, before a single request: `credentials_unreadable`
 * (28b item 10: its row names credentials and this process has none it can
 * use) or `not_allowed` (28b T5: this process's allowlist refuses it).
 * Conditioned on `queued` and on the job still being this runner's, as every
 * runner close is: a row another writer moved (or adopted) is left as it is,
 * and the job is abandoned.
 */
async function pauseBeforeStart(
  deps: CrawlJobDeps,
  job: ClaimedJob,
  reason: "credentials_unreadable" | "not_allowed",
  why: string,
): Promise<void> {
  const p = deps.logPrefix ?? "api";
  const crawlId = job.crawlId;
  const moved = await deps.db.transaction(async (tx) => {
    // While the job is still this runner's (28b T4b), read as the run's own
    // claim reads it (`ResumeOpts.owner`): the crawl row locked, then the job
    // row. An adopted crawl is not ours.
    const run = await lockRunOwnership(tx, crawlId, { jobId: job.id, instanceId: job.claimedBy });
    if (!run.owned) {
      await finishJob(tx, job.id, "abandoned");
      return 0;
    }
    const result = await tx
      .update(crawls)
      .set({
        status: "paused",
        pauseReason: reason,
        // As every pause writes it: when the crawl stopped.
        finishedAt: new Date(),
        controlRequest: null,
      })
      .where(and(eq(crawls.id, crawlId), eq(crawls.status, "queued")));
    if (result.rowCount === null) {
      throw new Error(`queue runner: the pause of crawl ${crawlId} reported no row count`);
    }
    await finishJob(tx, job.id, result.rowCount === 0 ? "abandoned" : "done");
    return result.rowCount;
  });
  deps.log(
    moved === 0
      ? `${p}: crawl ${crawlId} left the queue state before it could be paused (${reason}: ${why}); not started`
      : reason === "not_allowed"
        ? `${p}: crawl ${crawlId} paused (not_allowed) before any request: ${why}. ` +
          "crawl_resume re-checks it against the allowlist of the server that takes the call"
        : `${p}: crawl ${crawlId} paused (credentials_unreadable) before any request: it needs ` +
          `credentials and ${why}. crawl_resume with them continues it`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

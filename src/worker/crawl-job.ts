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
import { crawls } from "../db/schema.js";
import {
  ClaimLostError,
  failureReasonOf,
  parseStoredConfig,
  resumeCrawl,
  type CloseHook,
  type CrawlConfig,
} from "../crawl/loop.js";
import { describeShape, sameShape, shapeOf, type CrawlCredentials, type CredentialShape } from "../crawl/credentials.js";
import type { CredentialRead, CredentialVault } from "../crawl/credential-vault.js";
import { finishJob, type ClaimedJob, type JobOutcome } from "./jobs.js";

export interface CrawlJobDeps {
  db: Db;
  vault: CredentialVault;
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

/** The loop's close hook for one job: settle it in the close's transaction. */
export function crawlJobCloseHook(jobId: string): CloseHook {
  return async (tx, closed) => {
    await finishJob(tx, jobId, crawlJobOutcome(closed), closed.failureReason ?? undefined);
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
        await pauseUnreadable(deps, job, stored.why);
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
      onClose: crawlJobCloseHook(job.id),
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
    // NOT ONE TRANSACTION with the job's settle, unlike every other end: this
    // close must go through the same handle as the run it records, so a
    // database that refused the run refuses the record too and says so
    // (http.test's "cannot even record its own failure"). The window — the row
    // `failed`, its job still `running` for one statement — can only make a
    // resume answer "already held" once; it never runs a crawl twice.
    log(`${p}: crawl ${crawlId} threw — ${messageOf(error)}`);
    try {
      await db
        .update(crawls)
        .set({
          status: "failed",
          finishedAt: new Date(),
          // The loop's own helper: one rule for what may go in this column.
          failureReason: failureReasonOf(error),
        })
        .where(and(eq(crawls.id, crawlId), eq(crawls.status, "queued")));
      await finishJob(db, job.id, "failed", failureReasonOf(error));
    } catch (recordError) {
      log(
        `${p}: crawl ${crawlId} — the queue runner itself failed and could not record it: ` +
          messageOf(recordError),
      );
      throw recordError;
    }
  }
}

/**
 * Close a queued crawl `paused` with `pause_reason = 'credentials_unreadable'`
 * (28b item 10), and settle its job, in one transaction: its row names
 * credentials and this process has none it can use. Nothing was fetched.
 * Conditioned on `queued`, as every runner close is: a row another writer
 * moved is left as it is, and the job is abandoned.
 */
async function pauseUnreadable(deps: CrawlJobDeps, job: ClaimedJob, why: string): Promise<void> {
  const p = deps.logPrefix ?? "api";
  const crawlId = job.crawlId;
  const moved = await deps.db.transaction(async (tx) => {
    const result = await tx
      .update(crawls)
      .set({
        status: "paused",
        pauseReason: "credentials_unreadable",
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
      ? `${p}: crawl ${crawlId} left the queue state before it could be paused for its ` +
          `credentials (${why}); not started`
      : `${p}: crawl ${crawlId} paused (credentials_unreadable) before any request: it needs ` +
          `credentials and ${why}. crawl_resume with them continues it`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

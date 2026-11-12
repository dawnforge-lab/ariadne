/**
 * Running one claimed chain link (Phase 28c Task 6): a `render` or `rules` job
 * a fired crawl's finish queued (`crawlJobCloseHook`, src/worker/crawl-job.ts),
 * the `execute` of a runner over those kinds — an in-process service's (pinned
 * to it), or a worker's (the unpinned pool).
 *
 * A queued render or rules job is always a chain link: the synchronous
 * `crawl_render` and `crawl_rules` insert theirs `running` (`withPinnedJob`),
 * and nothing else queues one. So a link whose crawl has no `schedule_chain`,
 * or a `render` job on a chain that does not render, is a defect, and fails
 * loudly through the path below.
 *
 * THE LINKS ARE THE API'S OWN: `runRenderLink` and `runRulesLink`, which
 * `crawl_render` and `crawl_rules` call, with `where: "chain"`. A chain never
 * sends credentials; the crawl's stored copy is used, or the link fails
 * `CREDENTIALS_REQUIRED` naming `schedule_update`.
 *
 * THE ALLOWLIST AND URL POLICY, WHERE THE LINK RUNS. A render link fetches,
 * and it may run on a process other than the one that crawled (a worker with
 * an allowlist of its own), so before anything else it re-checks the crawl's
 * hosts against THIS process's allowlist exactly as a crawl job does at claim
 * (`crawlAllowlistRefusal`); a refusal fails the link `FORBIDDEN`. A schedule's
 * `render.urls` were only normalised when the schedule was written: they are
 * checked here as `crawl_render` checks a caller's list (`checkRenderUrls`,
 * through `runRenderLink`) — url-policy, the allowlist, a page of this crawl
 * that answered 200.
 *
 * DOCUMENTS. `renderHtmlDir` is the caller's: an in-process service passes its
 * `renderDir`, a worker null (no document is written, and the pages'
 * `rendered_html_path` stays null — globals, "Rendered documents").
 *
 * EVERY END IS ONE TRANSACTION, the crawl row locked first and then the job
 * row (`lockRunOwnership`, the order every writer of the pair takes):
 *
 *  - SUCCESS: the job settled `done`, and after a render the `rules` link
 *    enqueued with the same pin (C4) — together, so the scheduler's overlap
 *    read never sees the crawl between two links with neither live.
 *  - A THROW: the job settled `failed` (`jobError` of the message, operator
 *    side) and `schedule_chain_failed{link, reason}` recorded, with the crawl
 *    id and the crawl's CURRENT `schedule_id` (null once the schedule was
 *    deleted, which leaves its crawls' chains to run on). The chain stops
 *    there: nothing further is enqueued. The error is then rethrown, so the
 *    runner logs it and counts the job failed; its own settle finds the job
 *    settled and writes nothing.
 *  - THE JOB TAKEN FROM THE RUNNER while the link ran (a reaper read this
 *    process as dead and abandoned it): the work is done but the job is not
 *    this runner's to settle or to continue from, so nothing is enqueued and
 *    `schedule_chain_failed` says why — never a chain that just stops.
 *
 * The event's `reason` is the tenant's to read (`crawl_history`), so it says
 * only what an API answer would: a refusal's own sentence (a `ServiceError`,
 * with its code), or, for anything else — a defect, a browser that would not
 * launch — that the link failed internally and the id its detail is logged
 * under, as a 500 does. A raw error can carry a path on this machine.
 *
 * NOT INTERRUPTIBLE. Neither link takes the runner's abort signal (neither
 * `crawl_render` nor `crawl_rules` can be stopped part-way either): a link
 * running when its runner stops runs to its end and settles as above.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { ServiceError } from "../api/errors.js";
import type { Db } from "../db/client.js";
import { crawls } from "../db/schema.js";
import type { CredentialVault } from "../crawl/credential-vault.js";
import { readScheduleChain } from "../crawl/insert-crawl.js";
import { lockRunOwnership, parseStoredConfig } from "../crawl/loop.js";
import { runRenderLink } from "../crawl/render/render-link.js";
import type { AddressResolver } from "../crawl/url-policy.js";
import { recordEvent } from "../events/events.js";
import type { Registry } from "../rules/registry/registry.js";
import { runRulesLink } from "../rules/rules-link.js";
import { crawlAllowlistRefusal } from "./crawl-job.js";
import { enqueueJob, finishJob, jobError, type ClaimedJob, type Tx } from "./jobs.js";

export interface ChainJobDeps {
  db: Db;
  vault: CredentialVault;
  /** The rules the `rules` link runs: the process's one registry. */
  registry: Registry;
  /** Where a render link keeps its documents: the service's `renderDir`; null in a worker (none kept). */
  renderHtmlDir: string | null;
  /** Process trust (code only): may a render link fetch private addresses. */
  allowPrivate: boolean;
  /**
   * This process's crawl allowlist, as `crawlJobExecutor` takes it. Required:
   * a render link fetches, and a runner with no answer would render what it
   * was handed.
   */
  hostAllowed: (host: string) => boolean;
  /** TEST ONLY: the render browser's resolver (`ServiceConfig.resolveAddress`). */
  resolveAddress?: AddressResolver;
  log: (line: string) => void;
  /** The log lines' prefix: `api` in the API service, `worker` in a worker. */
  logPrefix?: string;
}

type Link = "render" | "rules";

/** The `execute` of a runner over `render` and `rules` jobs: one chain link each. */
export function chainJobExecutor(deps: ChainJobDeps): (job: ClaimedJob, signal: AbortSignal) => Promise<void> {
  // The signal is not taken: see "NOT INTERRUPTIBLE" in the module header.
  return (job) => runChainJob(deps, job);
}

async function runChainJob(deps: ChainJobDeps, job: ClaimedJob): Promise<void> {
  if (job.kind !== "render" && job.kind !== "rules") {
    throw new Error(`chain runner: job ${job.id} is a '${job.kind}' job; a chain link is a render or rules job`);
  }
  const link: Link = job.kind;
  try {
    await runLink(deps, job, link);
    await settleLink(deps, job, link);
  } catch (error) {
    await recordChainFailure(deps, job, link, error);
    throw error;
  }
}

/** Run the link's work: the API's own render or rules link, with the chain's settings. */
async function runLink(deps: ChainJobDeps, job: ClaimedJob, link: Link): Promise<void> {
  const p = deps.logPrefix ?? "api";
  const crawlId = job.crawlId;
  const [row] = await deps.db
    .select({ config: crawls.config, chain: crawls.scheduleChain })
    .from(crawls)
    .where(and(eq(crawls.id, crawlId), eq(crawls.tenantId, job.tenant)));
  if (row === undefined) throw new Error(`chain runner: ${link} job ${job.id} names crawl ${crawlId}, which does not exist`);
  if (row.chain === null) {
    throw new Error(
      `chain runner: crawl ${crawlId} has a queued ${link} job and no schedule_chain; only a chain queues one, ` +
        "so this is a defect",
    );
  }
  const chain = readScheduleChain(row.chain, crawlId);
  if (link === "rules") {
    const summary = await runRulesLink(deps.db, job.tenant, crawlId, deps.registry);
    deps.log(
      `${p}: crawl ${crawlId} chain rules — ${summary.findings} finding(s) over ${summary.pagesScanned} page(s)`,
    );
    return;
  }
  if (chain.render === null) {
    throw new Error(
      `chain runner: crawl ${crawlId} has a queued render job and its chain renders nothing; this is a defect`,
    );
  }
  // Before the credentials are read and before anything is fetched, as a
  // crawl job checks its crawl at claim (module header).
  const refusal = crawlAllowlistRefusal(parseStoredConfig(row.config, crawlId), deps.hostAllowed);
  if (refusal !== null) {
    throw new ServiceError("FORBIDDEN", `the render link was refused before any request: ${refusal}`);
  }
  const urls = chain.render.urls;
  const summary = await runRenderLink(deps.db, deps.vault, job.tenant, crawlId, {
    ...(urls === undefined ? {} : { urls }),
    renderHtmlDir: deps.renderHtmlDir,
    allowPrivate: deps.allowPrivate,
    hostAllowed: deps.hostAllowed,
    ...(deps.resolveAddress === undefined ? {} : { resolveAddress: deps.resolveAddress }),
    log: deps.log,
    where: "chain",
  });
  deps.log(
    `${p}: crawl ${crawlId} chain render — ${summary.rendered} rendered, ${summary.failures} failed` +
      (deps.renderHtmlDir === null ? " (no documents kept)" : ""),
  );
}

/**
 * The link's work is done: settle its job `done` and, after a render, enqueue
 * the rules link — one transaction (module header). A job no longer this
 * runner's is neither settled nor continued from, and the chain's stop is
 * recorded.
 */
async function settleLink(deps: ChainJobDeps, job: ClaimedJob, link: Link): Promise<void> {
  const crawlId = job.crawlId;
  const lost = await deps.db.transaction(async (tx) => {
    const run = await lockRunOwnership(tx, crawlId, { jobId: job.id, instanceId: job.claimedBy });
    if (run.status === null) throw new Error(`chain runner: crawl ${crawlId} was deleted while its ${link} link ran`);
    if (!run.owned) {
      await recordEvent(tx, {
        tenant: job.tenant,
        crawlId,
        scheduleId: await scheduleIdOf(tx, crawlId),
        kind: "schedule_chain_failed",
        detail: {
          link,
          reason:
            `the ${link} link's job was taken from the runner that ran it (its process was read as ` +
            "stopped or silent) before the link could be settled; the chain stops here",
        },
      });
      return true;
    }
    await finishJob(tx, job.id, "done");
    if (link === "render") {
      await enqueueJob(tx, {
        tenant: job.tenant,
        crawlId,
        kind: "rules",
        ...(job.pinnedTo === null ? {} : { pinnedTo: job.pinnedTo }),
      });
    }
    return false;
  });
  if (lost) {
    deps.log(
      `${deps.logPrefix ?? "api"}: crawl ${crawlId}: its ${link} job ${job.id} was taken from this runner while ` +
        "the link ran; nothing further is enqueued (schedule_chain_failed recorded)",
    );
  }
}

/**
 * A link threw: settle its job `failed` and record `schedule_chain_failed`, in
 * one transaction (module header). A crawl deleted meanwhile took its job and
 * its events with it: there is nothing to settle or record, and that is said.
 * A failure to record is thrown beside the link's own error, never in its place.
 */
async function recordChainFailure(deps: ChainJobDeps, job: ClaimedJob, link: Link, error: unknown): Promise<void> {
  const p = deps.logPrefix ?? "api";
  const crawlId = job.crawlId;
  const reason = tenantReason(deps, job, link, error);
  let gone = false;
  try {
    await deps.db.transaction(async (tx) => {
      const run = await lockRunOwnership(tx, crawlId, { jobId: job.id, instanceId: job.claimedBy });
      if (run.status === null) {
        gone = true;
        return;
      }
      // A job taken from this runner is settled already, and stays as it is.
      await finishJob(tx, job.id, "failed", messageOf(error));
      await recordEvent(tx, {
        tenant: job.tenant,
        crawlId,
        scheduleId: await scheduleIdOf(tx, crawlId),
        kind: "schedule_chain_failed",
        detail: { link, reason },
      });
    });
  } catch (recordError) {
    throw new AggregateError(
      [error, recordError],
      `crawl ${crawlId}: the chain's ${link} link failed, and recording its failure failed too`,
    );
  }
  deps.log(
    gone
      ? `${p}: crawl ${crawlId} chain ${link} failed, and the crawl is gone (deleted with its jobs and events): ` +
          "nothing to record"
      : `${p}: crawl ${crawlId} chain ${link} failed — ${reason}; the chain stops here`,
  );
}

/**
 * The `reason` a tenant reads (module header): a refusal's own sentence, or an
 * internal failure and the id its detail is logged under.
 */
function tenantReason(deps: ChainJobDeps, job: ClaimedJob, link: Link, error: unknown): string {
  if (error instanceof ServiceError) return jobError(`${error.code}: ${error.message}`);
  const correlationId = randomUUID();
  deps.log(
    `${deps.logPrefix ?? "api"}: chain ${link} ${correlationId} crawl ${job.crawlId} job ${job.id} — ` +
      (error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );
  return `the ${link} link failed with an internal error; detail logged under ${correlationId}`;
}

/** The crawl's current `schedule_id`, read under the lock its caller holds on the row. */
async function scheduleIdOf(tx: Tx, crawlId: string): Promise<string | null> {
  const [row] = await tx.select({ scheduleId: crawls.scheduleId }).from(crawls).where(eq(crawls.id, crawlId));
  if (row === undefined) throw new Error(`chain runner: crawl ${crawlId} vanished under its own row lock`);
  return row.scheduleId;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

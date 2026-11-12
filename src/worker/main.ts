/**
 * `startWorker` (Phase 28b Task 5): the worker role as a library call.
 *
 * `src/worker/serve.ts` reads the environment and calls it; the trusted test
 * child (`scripts/run-worker-trusted.ts`) calls it with its process trust in
 * code. A worker registers an instance with role `worker`, runs a `JobRunner`
 * over `crawl` jobs of the unpinned pool, and serves a liveness endpoint.
 *
 *  - FAIR CLAIMS: `maxRunningPerTenant` is the pool's per-tenant cap (R9);
 *    host exclusivity is the claim's own (28b T4a).
 *  - THE REAPER runs here (R10): dead processes' jobs are settled, system-
 *    paused pool crawls requeued, expired credentials swept, dead instance rows
 *    deleted. `credentialRetentionDays` is that sweep's window.
 *  - THE ALLOWLIST is re-checked where the crawl runs (`allowedDomains`;
 *    src/worker/crawl-job.ts): a crawl this worker does not allow closes
 *    `paused` (`not_allowed`) before a request.
 *  - PROCESS TRUST (`processTrust`: `allowPrivate`, `recheckMinGapMs`) is an
 *    argument, never a variable: nothing in this file or in `serve.ts` reads
 *    it from the environment, and absent it a worker refuses loopback and
 *    private targets.
 *  - THE HTTP SERVER serves the shared `/healthz`, `/readyz` and `/metrics`
 *    (src/ops/serve.ts, 28b T6) and nothing else: any other path, or a non-GET,
 *    is a 404. `/metrics` takes `metricsToken`; absent, it is a 404 and one
 *    boot line says so.
 *
 * THE SCHEDULER (Phase 28c, `scheduler`): off unless asked for; `worker:serve`
 * turns it on. A worker's scheduler fires crawls into the unpinned pool (C4)
 * and applies this worker's allowlist.
 *
 * `stop()` (graceful shutdown, SIGTERM): stop the scheduler first; stop
 * claiming; abort every running
 * crawl, which its loop closes `paused` (`shutdown`) with its job `abandoned`
 * in the same transaction; leave queued jobs queued; mark the instance
 * stopped, so it is not live and nothing it held is read as held; close the
 * HTTP server. The instance keeps heartbeating until its crawls have closed:
 * a crawl that takes longer to close than `deadAfter` must not be read as a
 * dead process's by another worker's reaper while this one is still writing it.
 */
import { createServer, type Server } from "node:http";

import type { Db } from "../db/client.js";
import {
  CredentialVault,
  DEFAULT_CREDENTIAL_RETENTION_DAYS,
  assertRetentionDays,
  type CredentialKeys,
} from "../crawl/credential-vault.js";
import type { CrawlConfig } from "../crawl/loop.js";
import { isHostAllowed } from "../api/config.js";
import { Scheduler, connectionStringOf, type SchedulerTestSeam } from "../schedule/scheduler.js";
import { serveOps } from "../ops/serve.js";
import { crawlJobExecutor } from "./crawl-job.js";
import { registerInstance, stopInstance } from "./instance.js";
import { assertTenantCap } from "./jobs.js";
import { JobRunner } from "./runner.js";
import { timingWith, type Timing } from "./timing.js";

export interface StartWorkerOptions {
  db: Db;
  credentialKeys: CredentialKeys;
  /** How many crawls this worker runs at once: a positive whole number. */
  concurrency: number;
  /** The pool's per-tenant cap (`ARIADNE_TENANT_MAX_RUNNING`). */
  maxRunningPerTenant: number;
  /** The liveness port; 0 asks the system for one (`RunningWorker.port` says which). */
  httpPort: number;
  /** The bearer `/metrics` takes; null serves it to nobody (404, and a boot line). */
  metricsToken: string | null;
  /**
   * This worker's crawl allowlist (`ARIADNE_ALLOWED_DOMAINS`, through
   * `parseAllowedDomains`). Required, and empty means every crawl is refused.
   */
  allowedDomains: readonly string[];
  /** Days a settled crawl keeps its stored credentials; 30 when absent. */
  credentialRetentionDays?: number;
  /** Process trust, in code only (module header). Absent: no private targets. */
  processTrust?: Pick<CrawlConfig, "allowPrivate" | "recheckMinGapMs">;
  /** The worker clock (src/worker/timing.ts); code-only, a test injects a short one. */
  timing?: Partial<Timing>;
  /** Where diagnostics go; defaults to `console.error`. */
  log?: (line: string) => void;
  /** The address the liveness server binds. `0.0.0.0` when absent: an orchestrator's probe comes from outside the host. */
  httpHost?: string;
  /**
   * TEST ONLY (`ReapOptions.onlyInstances`): the instances this worker's reaper
   * is confined to, given its own id. Production never passes it.
   */
  reaperOnlyInstances?: (instanceId: string) => readonly string[];
  /**
   * Whether this worker is a scheduler candidate (src/schedule/scheduler.ts);
   * off when absent. `worker:serve` passes `true`. The object form is TEST
   * ONLY (`SchedulerTestSeam`: a lock key and the tenants it fires), code-only.
   */
  scheduler?: boolean | SchedulerTestSeam;
}

export interface RunningWorker {
  instanceId: string;
  /** The port the liveness server is listening on. */
  port: number;
  /** Graceful shutdown (module header). Once; later calls return the same promise. */
  stop(): Promise<void>;
}

export async function startWorker(opts: StartWorkerOptions): Promise<RunningWorker> {
  // Everything refusable is refused before a socket opens or a row is written.
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(`startWorker: concurrency must be a positive whole number, got ${String(opts.concurrency)}`);
  }
  assertTenantCap(null, opts.maxRunningPerTenant, "startWorker");
  if (!Number.isInteger(opts.httpPort) || opts.httpPort < 0 || opts.httpPort > 65535) {
    throw new Error(`startWorker: httpPort must be a port number, got ${String(opts.httpPort)}`);
  }
  const retentionDays = opts.credentialRetentionDays ?? DEFAULT_CREDENTIAL_RETENTION_DAYS;
  assertRetentionDays(retentionDays, "startWorker credentialRetentionDays");
  const timing = timingWith(opts.timing);
  const log = opts.log ?? ((line: string) => console.error(line));
  // The keys are checked by the vault's constructor.
  const vault = new CredentialVault(opts.db, opts.credentialKeys);
  const allowedDomains = [...opts.allowedDomains];
  const processTrust = opts.processTrust ?? { allowPrivate: false };
  const schedulerSeam = opts.scheduler ?? false;
  const schedulerUrl = schedulerSeam === false ? null : connectionStringOf(opts.db);

  if (opts.metricsToken === null) {
    log("ariadne worker: ARIADNE_METRICS_TOKEN is unset, so /metrics answers 404 (set it to expose metrics)");
  }
  const server = createOpsServer(opts.db, opts.metricsToken, log);
  const port = await listen(server, opts.httpPort, opts.httpHost ?? "0.0.0.0");

  let instanceId: string | null = null;
  let runner: JobRunner;
  let scheduler: Scheduler | null = null;
  try {
    instanceId = await registerInstance(opts.db, "worker");
    const id = instanceId;
    const only = opts.reaperOnlyInstances;
    // Built (and so checked) before the runner starts; started after it.
    if (schedulerUrl !== null && schedulerSeam !== false) {
      scheduler = new Scheduler(schedulerUrl, opts.db, {
        vault,
        hostAllowed: (host) => isHostAllowed(host, allowedDomains),
        // A worker fires into the pool (C4).
        pin: null,
        log,
        instanceId: id,
        timing,
        ...(schedulerSeam === true ? {} : schedulerSeam),
      });
    }
    runner = new JobRunner(opts.db, {
      instanceId: id,
      kinds: ["crawl"],
      pinnedTo: null,
      maxRunningPerTenant: opts.maxRunningPerTenant,
      concurrency: opts.concurrency,
      timing: opts.timing ?? {},
      log,
      execute: crawlJobExecutor({
        db: opts.db,
        vault,
        hostAllowed: (host) => isHostAllowed(host, allowedDomains),
        processTrust,
        log,
        logPrefix: "worker",
      }),
      reaper: {
        vault,
        retentionDays,
        ...(only === undefined ? {} : { onlyInstances: () => only(id) }),
      },
    });
    runner.start();
    scheduler?.start();
  } catch (error) {
    // Nothing is left half-started: the socket closed, the instance (if it
    // registered) stopped, and the error is the caller's.
    await closeServer(server);
    if (instanceId !== null) await stopInstance(opts.db, instanceId);
    throw error;
  }

  const id = instanceId;
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // Still beating while the crawls close (module header).
      const beat = setInterval(() => {
        runner.beatOnce().catch((error: unknown) => {
          log(`worker ${id}: heartbeat during shutdown failed — ${messageOf(error)}`);
        });
      }, timing.heartbeat);
      // Every step runs whatever an earlier one did; the first error is rethrown.
      const errors: unknown[] = [];
      const step = async (what: () => Promise<void>): Promise<void> => {
        try {
          await what();
        } catch (error) {
          errors.push(error);
        }
      };
      // The scheduler first: nothing is fired by a worker that is closing.
      const firing = scheduler;
      if (firing !== null) await step(() => firing.stop());
      await step(() => runner.stop());
      clearInterval(beat);
      await step(() => closeServer(server));
      await step(() => stopInstance(opts.db, id));
      if (errors.length > 0) {
        for (const extra of errors.slice(1)) log(`worker ${id}: a further shutdown step failed — ${messageOf(extra)}`);
        throw errors[0];
      }
    })();
    return stopping;
  };
  return { instanceId: id, port, stop };
}

/** `/healthz`, `/readyz` and `/metrics` (src/ops/serve.ts); every other request is a 404. */
function createOpsServer(db: Db, metricsToken: string | null, log: (line: string) => void): Server {
  return createServer((req, res) => {
    serveOps(req, res, { db, metricsToken, log })
      .then((served) => {
        if (served) return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      })
      .catch((error: unknown) => {
        log(`worker: ops handler failed — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        } else res.destroy();
      });
  });
}

async function listen(server: Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("startWorker: the liveness server bound oddly");
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

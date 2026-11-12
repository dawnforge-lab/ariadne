/**
 * `npm run worker:serve` — a crawl worker, configured from the environment.
 *
 * Required (a missing or malformed one is a boot error naming it, and nothing
 * is started):
 *
 *  - `DATABASE_URL`
 *  - `ARIADNE_CREDENTIALS_KEY` (`<id>:<base64 of 32 bytes>`), and optionally
 *    `ARIADNE_CREDENTIALS_KEY_PREVIOUS` for a rotation window
 *  - `ARIADNE_WORKER_HTTP_PORT`: the liveness/readiness/metrics port
 *  - `ARIADNE_ALLOWED_DOMAINS`: the crawl allowlist THIS worker enforces when
 *    it claims a crawl (the API enforces its own when it accepts one). Unset is
 *    a boot error, because a worker must be told explicitly; set to the empty
 *    string it is allowed and means every crawl is refused.
 *
 * Optional: `ARIADNE_WORKER_CONCURRENCY` (crawls at once, default 1),
 * `ARIADNE_TENANT_MAX_RUNNING` (the pool's per-tenant cap, default 1),
 * `ARIADNE_METRICS_TOKEN`, `ARIADNE_CREDENTIALS_RETENTION_DAYS`.
 *
 * PROCESS TRUST IS NOT HERE, AND MUST NOT BE. The test-only crawl fields that
 * admit loopback and private-network targets are code-level arguments of
 * `startWorker` (src/worker/main.ts): this file constructs the worker without
 * them, so the only way to set them is to import `startWorker` from code that
 * means to (`scripts/run-worker-trusted.ts`). No variable of any spelling
 * reaches them; test/worker/serve.test.ts pins both the source and the
 * behaviour.
 *
 * SIGTERM and SIGINT: stop claiming, pause the crawls that are running
 * (`shutdown`) and abandon their jobs, leave queued jobs queued, mark the
 * instance stopped, close the database, exit 0 (`RunningWorker.stop`).
 */
import { closeDb, createDb } from "../db/client.js";
import { parseCredentialKeys, parseCredentialRetentionDays } from "../crawl/credential-vault.js";
import { parseAllowedDomains } from "../api/config.js";
import { parseTenantMaxRunning } from "./runner.js";
import { startWorker, type RunningWorker } from "./main.js";

/** `ARIADNE_WORKER_CONCURRENCY` when it is not set. */
const DEFAULT_WORKER_CONCURRENCY = 1;

interface WorkerEnv {
  databaseUrl: string;
  httpPort: number;
  concurrency: number;
  maxRunningPerTenant: number;
  metricsToken: string | null;
  allowedDomains: string[];
  credentialKeys: ReturnType<typeof parseCredentialKeys>;
  credentialRetentionDays: number;
}

/** A positive whole number written plainly, or an error naming the variable. */
function plainPositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw.slice(0, 40))}`);
  }
  return value;
}

function loadWorkerEnv(env: NodeJS.ProcessEnv): WorkerEnv {
  const databaseUrl = (env["DATABASE_URL"] ?? "").trim();
  if (databaseUrl === "") {
    throw new Error("DATABASE_URL must be set: a worker claims its crawls from the database");
  }
  const rawPort = (env["ARIADNE_WORKER_HTTP_PORT"] ?? "").trim();
  if (rawPort === "") {
    throw new Error(
      "ARIADNE_WORKER_HTTP_PORT must be set: the worker serves its health endpoint there, and there is no default",
    );
  }
  const httpPort = Number(rawPort);
  if (!/^[0-9]+$/.test(rawPort) || httpPort > 65535) {
    throw new Error(`ARIADNE_WORKER_HTTP_PORT is not a port number: ${JSON.stringify(rawPort.slice(0, 40))}`);
  }
  const rawDomains = env["ARIADNE_ALLOWED_DOMAINS"];
  if (rawDomains === undefined) {
    throw new Error(
      "ARIADNE_ALLOWED_DOMAINS must be set: a worker re-checks every crawl it claims against its own " +
        "allowlist, and is told it explicitly (set it to the empty string to refuse every crawl)",
    );
  }
  const metrics = (env["ARIADNE_METRICS_TOKEN"] ?? "").trim();
  return {
    databaseUrl,
    httpPort,
    concurrency: plainPositiveInt("ARIADNE_WORKER_CONCURRENCY", env["ARIADNE_WORKER_CONCURRENCY"], DEFAULT_WORKER_CONCURRENCY),
    maxRunningPerTenant: parseTenantMaxRunning(env["ARIADNE_TENANT_MAX_RUNNING"]),
    metricsToken: metrics === "" ? null : metrics,
    allowedDomains: parseAllowedDomains(rawDomains),
    // Each names its own variable in its refusal; both read the whole
    // environment on purpose, and read only theirs.
    credentialKeys: parseCredentialKeys(process.env),
    credentialRetentionDays: parseCredentialRetentionDays(process.env),
  };
}

let config: WorkerEnv;
try {
  config = loadWorkerEnv(process.env);
} catch (error) {
  console.error(`ariadne worker: cannot start — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const db = createDb(config.databaseUrl);
let worker: RunningWorker;
try {
  worker = await startWorker({
    db,
    credentialKeys: config.credentialKeys,
    credentialRetentionDays: config.credentialRetentionDays,
    concurrency: config.concurrency,
    maxRunningPerTenant: config.maxRunningPerTenant,
    httpPort: config.httpPort,
    metricsToken: config.metricsToken,
    allowedDomains: config.allowedDomains,
    // A scheduler candidate (28c), firing into the pool.
    scheduler: true,
  });
} catch (error) {
  console.error(`ariadne worker: cannot start — ${error instanceof Error ? error.message : String(error)}`);
  await closeDb(db);
  process.exit(1);
}

console.error(
  `ariadne worker ${worker.instanceId} listening on :${worker.port} — ` +
    `${config.allowedDomains.length} allowed domain(s), concurrency ${config.concurrency}, ` +
    `${config.maxRunningPerTenant} running per tenant`,
);
if (config.allowedDomains.length === 0) {
  console.error(
    "ariadne worker: the crawl allowlist is EMPTY — every crawl this worker claims is paused " +
      "(not_allowed) and nothing is fetched (set ARIADNE_ALLOWED_DOMAINS).",
  );
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      // A shutdown that cannot finish must not need a SIGKILL.
      console.error(`ariadne worker: ${signal} again while closing — exiting at once (1)`);
      process.exit(1);
    }
    shuttingDown = true;
    console.error(`ariadne worker: ${signal} — closing (a running crawl is paused (shutdown), not killed)`);
    worker
      .stop()
      .then(() => closeDb(db))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`ariadne worker: shutdown failed — ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  });
}

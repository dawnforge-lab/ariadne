/**
 * A TRUSTED WORKER, for tests and gates: `startWorker` with the process trust a
 * production worker never has, held IN CODE.
 *
 *   DATABASE_URL=… ARIADNE_CREDENTIALS_KEY=… node --import tsx scripts/run-worker-trusted.ts
 *
 * It exists because the gate and the test suite crawl loopback fixture
 * servers, which the URL policy refuses unless `allowPrivate` is set — and
 * `allowPrivate` is a code-level argument that no environment variable may
 * reach (`src/worker/serve.ts` does not read one). The two process-trust
 * fields and the allowlist below are therefore written here, in code, and a
 * test pins that the file never reads them from the environment.
 *
 * THE ALLOWLIST is the loopback fixture hosts 127.0.0.1 to 127.0.0.4. A crawl
 * of any other host is refused at claim (`not_allowed`), which is what the
 * allowlist tests rely on.
 *
 * What the environment DOES carry here is plumbing, none of it trust:
 *
 *  - `DATABASE_URL`, `ARIADNE_CREDENTIALS_KEY`: as for the real worker;
 *  - `TRUSTED_WORKER_CONCURRENCY`: crawls at once (default 1);
 *  - `TRUSTED_WORKER_TIMING`: JSON, a `Partial<Timing>` (a short clock);
 *  - `TRUSTED_WORKER_METRICS_TOKEN`: the bearer `/metrics` takes (unset: `/metrics`
 *    answers 404, as on a real worker without `ARIADNE_METRICS_TOKEN`); the
 *    gate scrapes it to prove no credential value reaches a metric;
 *  - `TRUSTED_WORKER_PEERS_FILE`: a JSON array of instance ids, read at every
 *    reaper tick. The reaper is CONFINED (`onlyInstances`, test only) to those
 *    and to this worker's own id: tests share a database, and an unconfined
 *    reaper on a short clock would settle other suites' rows. Without the
 *    variable the reaper is confined to this worker alone.
 *
 * THE SCHEDULER (28c) is off unless the parent asks for it ON THE COMMAND LINE,
 * never through the environment (`worker:serve` turns it on in code; no
 * variable reaches either):
 *
 *  - `--scheduler`: this worker is a scheduler candidate on the PRODUCTION lock
 *    key, firing every tenant's schedules — what a deployed worker does. Only a
 *    database of its own may see one (the 28c gate's `ariadne_gate28c`): it
 *    would fire any due schedule it finds.
 *  - `--schedule-every-ms=<n>`: its `Timing.scheduleEvery` (30 s when absent);
 *    only with `--scheduler`. `TRUSTED_WORKER_TIMING` may not carry
 *    `scheduleEvery`, so the value has one source.
 *
 * Any other argument is refused, by position, before anything starts.
 *
 * It prints one line, `READY {"instanceId": …, "port": …}`, on stdout once the
 * worker is registered and listening (diagnostics go to stderr), and shuts down
 * gracefully on SIGTERM or SIGINT, exiting 0, as `worker:serve` does.
 */
import { readFileSync } from "node:fs";

import { closeDb, createDb } from "../src/db/client.js";
import { parseCredentialKeys } from "../src/crawl/credential-vault.js";
import { startWorker } from "../src/worker/main.js";
import type { Timing } from "../src/worker/timing.js";

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value === "") throw new Error(`${name} must be set`);
  return value;
}

interface SchedulerArgs {
  scheduler: boolean;
  scheduleEvery: number | null;
}

/** The command line (module header): `--scheduler` and `--schedule-every-ms=<n>`, nothing else. */
function parseArgs(argv: readonly string[]): SchedulerArgs {
  const out: SchedulerArgs = { scheduler: false, scheduleEvery: null };
  for (const [index, arg] of argv.entries()) {
    if (arg === "--scheduler") {
      out.scheduler = true;
      continue;
    }
    const every = /^--schedule-every-ms=(\d+)$/.exec(arg);
    if (every !== null) {
      out.scheduleEvery = Number(every[1]);
      continue;
    }
    throw new Error(
      `run-worker-trusted: argument ${index + 1} is not one this script takes ` +
        "(--scheduler, --schedule-every-ms=<n>)",
    );
  }
  if (out.scheduleEvery !== null && !out.scheduler) {
    throw new Error("run-worker-trusted: --schedule-every-ms is a scheduler setting and needs --scheduler");
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const db = createDb(required("DATABASE_URL"));
const timing = JSON.parse(process.env["TRUSTED_WORKER_TIMING"] ?? "{}") as Partial<Timing>;
if (timing.scheduleEvery !== undefined) {
  throw new Error("run-worker-trusted: TRUSTED_WORKER_TIMING may not carry scheduleEvery; pass --schedule-every-ms=<n>");
}
if (args.scheduleEvery !== null) timing.scheduleEvery = args.scheduleEvery;
const peersFile = process.env["TRUSTED_WORKER_PEERS_FILE"];

const worker = await startWorker({
  db,
  credentialKeys: parseCredentialKeys(process.env),
  concurrency: Number(process.env["TRUSTED_WORKER_CONCURRENCY"] ?? "1"),
  maxRunningPerTenant: 1,
  httpPort: 0,
  httpHost: "127.0.0.1",
  metricsToken: (process.env["TRUSTED_WORKER_METRICS_TOKEN"] ?? "").trim() || null,
  // IN CODE: the loopback fixture hosts, and the trust to fetch them.
  allowedDomains: ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4"],
  processTrust: { allowPrivate: true },
  timing,
  // From the command line only (module header): the production key, every tenant.
  scheduler: args.scheduler,
  reaperOnlyInstances: (own) => {
    const peers = peersFile === undefined ? [] : (JSON.parse(readFileSync(peersFile, "utf8")) as string[]);
    return [...new Set([own, ...peers])];
  },
});

console.log(`READY ${JSON.stringify({ instanceId: worker.instanceId, port: worker.port })}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      console.error(`trusted worker: ${signal} again while closing — exiting at once (1)`);
      process.exit(1);
    }
    shuttingDown = true;
    worker
      .stop()
      .then(() => closeDb(db))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`trusted worker: shutdown failed — ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  });
}

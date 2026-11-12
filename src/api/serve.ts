/**
 * `npm run api:serve` — the HTTP surface, configured from the environment.
 *
 * Everything this entrypoint does is refuse or start: `loadApiConfig` throws on
 * a missing token, a missing database URL or a malformed allowlist entry, and
 * nothing here catches those. A server that booted with half a configuration
 * would be a surface an operator believes is protected.
 *
 * `crawlDefaults` is deliberately NOT settable from the environment. It is the
 * process-trust seam (`ApiServerConfig`), and the field an environment variable
 * would eventually be asked to carry is `allowPrivate` — the test-only escape
 * hatch that admits loopback and RFC1918 targets. Wiring it to env is exactly
 * what its docblock forbids, so this file constructs the server without it and
 * the only way to set it is to import `createApiServer` from code that means to.
 *
 * CRAWLS RUN ON WORKERS (28b T5). This process accepts and answers; it runs
 * none (`crawlRunner: "workers"`, role `api`): crawl jobs are left in the
 * pool for `npm run worker:serve`. It does run a REAPER (R10), so it settles
 * its own dead render and rules jobs and sweeps expired credentials whether or
 * not a worker is up. Render and rules calls still run here, synchronously.
 *
 * IT IS A SCHEDULER CANDIDATE (28c, `scheduler: true`): if it holds the leader
 * lock it fires due schedules into the worker pool; the service stops it first
 * when it closes.
 */
import { closeDb, createDb } from "../db/client.js";
import { CredentialVault, parseCredentialKeys, parseCredentialRetentionDays } from "../crawl/credential-vault.js";
import { ReaperLoop } from "../worker/reaper-loop.js";
import { timingWith } from "../worker/timing.js";
import { loadApiConfig } from "./config.js";
import { createApiServer } from "./http.js";
import { assertMetricsTokenDistinct } from "../ops/serve.js";

const config = loadApiConfig();
// Before anything is constructed: a missing or malformed key is a boot error
// naming the variable, never a server that cannot store credentials (28b).
const credentialKeys = parseCredentialKeys(process.env);
const credentialRetentionDays = parseCredentialRetentionDays(process.env);
// `ARIADNE_METRICS_TOKEN` is the bearer `GET /metrics` takes. Unset: the route
// answers 404 and is never open (said once at boot, below).
const metricsToken = (process.env["ARIADNE_METRICS_TOKEN"] ?? "").trim() || null;
assertMetricsTokenDistinct(metricsToken, config.token);
const db = createDb(config.databaseUrl);
const api = createApiServer({
  db,
  config: {
    token: config.token,
    metricsToken,
    allowedDomains: config.allowedDomains,
    credentialKeys,
    credentialRetentionDays,
    crawlRunner: "workers",
    // A scheduler candidate (28c): it starts with the instance, below, and
    // fires into the worker pool.
    scheduler: true,
    // Undefined means each field's own default — `exports/` and `renders/`; see
    // `ServiceConfig`. Unlike `crawlDefaults` these ARE environment knobs, and
    // safely so: they name where the server keeps its own output, not what it
    // may do.
    ...(config.exportDir === undefined ? {} : { exportDir: config.exportDir }),
    ...(config.renderDir === undefined ? {} : { renderDir: config.renderDir }),
  },
});

// Register this process's instance row and start its heartbeat NOW, not on the
// first render or rules job it happens to run (28b R18: every process
// heartbeats its instance row). A failed registration is a boot error.
const instanceId = await api.service.instanceId();

const reaper = new ReaperLoop(db, {
  vault: new CredentialVault(db, credentialKeys),
  retentionDays: credentialRetentionDays,
  timing: timingWith(),
  label: "api",
  log: (line) => console.error(line),
});
reaper.start();

const bound = await api.listen(config.port, process.env["ARIADNE_API_HOST"] ?? "127.0.0.1");
console.error(`ariadne api: instance ${instanceId}; crawls run on workers (npm run worker:serve); this process runs a reaper, not crawls`);
console.error(
  `ariadne api listening on http://${bound.host}:${bound.port} — ` +
    `${config.allowedDomains.length} allowed domain(s)`,
);
// Said at boot rather than left to be discovered: the render pass writes a file
// per rendered page and an operator needs to know where, before it grows.
console.error(
  `ariadne api: rendered documents -> ${config.renderDir ?? "renders/ (default; set ARIADNE_RENDER_DIR to move it)"}`,
);
// The same courtesy for the other output directory. On a billed audit
// `export_crawl` is the normal path, so this one fills up too.
console.error(
  `ariadne api: crawl exports -> ${config.exportDir ?? "exports/ (default; set ARIADNE_EXPORT_DIR to move it)"}`,
);
if (metricsToken === null) {
  console.error("ariadne api: ARIADNE_METRICS_TOKEN is unset, so /metrics answers 404 (set it to expose metrics)");
}
if (config.allowedDomains.length === 0) {
  console.error(
    "ariadne api: the crawl allowlist is EMPTY — every crawl trigger will be refused " +
      "with 403 (set ARIADNE_ALLOWED_DOMAINS). Queries are unaffected.",
  );
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`ariadne api: ${signal} — closing (a running crawl is paused (shutdown), not killed)`);
    // The queue's close aborts the crawl in flight and waits for it to write
    // its `paused` (shutdown) row, so a restart resumes rather than re-crawls.
    // The scheduler first (nothing is fired into a closing process), then the
    // reaper, then the surface.
    // A scheduler that could not release its lock is said and the shutdown
    // goes on: its session is ended either way, which frees the lock.
    api.service
      .stopScheduler()
      .catch((error: unknown) => {
        console.error(`ariadne api: the scheduler did not stop cleanly — ${String(error)}`);
      })
      .then(() => reaper.stop())
      .then(() => api.close())
      .then(() => closeDb(db))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`ariadne api: shutdown failed — ${String(error)}`);
        process.exit(1);
      });
  });
}

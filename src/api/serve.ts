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
 */
import { closeDb, createDb } from "../db/client.js";
import { loadApiConfig } from "./config.js";
import { createApiServer } from "./http.js";

const config = loadApiConfig();
const db = createDb(config.databaseUrl);
const api = createApiServer({
  db,
  config: {
    token: config.token,
    allowedDomains: config.allowedDomains,
    // Undefined means each field's own default — `exports/` and `renders/`; see
    // `ServiceConfig`. Unlike `crawlDefaults` these ARE environment knobs, and
    // safely so: they name where the server keeps its own output, not what it
    // may do.
    ...(config.exportDir === undefined ? {} : { exportDir: config.exportDir }),
    ...(config.renderDir === undefined ? {} : { renderDir: config.renderDir }),
  },
});

const bound = await api.listen(config.port, process.env["ARIADNE_API_HOST"] ?? "127.0.0.1");
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
    console.error(`ariadne api: ${signal} — closing (a running crawl is cancelled, not killed)`);
    // The queue's close aborts the crawl in flight and waits for it to write
    // its `cancelled` row, so a restart resumes rather than re-crawls.
    api
      .close()
      .then(() => closeDb(db))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`ariadne api: shutdown failed — ${String(error)}`);
        process.exit(1);
      });
  });
}

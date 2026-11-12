/**
 * `npm run mcp:serve` — the MCP surface on stdio, configured from the
 * environment.
 *
 * STDOUT BELONGS TO THE PROTOCOL. Every JSON-RPC frame the client reads is
 * written there, so nothing in this process may print to it: a single stray
 * `console.log` corrupts the stream and the client sees a parse error instead of
 * a tool result. All diagnostics — this file's, the service's, the crawl loop's
 * — go to stderr, which is where the service's default log already writes.
 *
 * The token this file does NOT read is the point of the file. `loadMcpConfig`
 * requires a database URL and a tenant (`ARIADNE_TENANT`, no default), reads the
 * crawl allowlist, and asks for no bearer token, because an stdio client is the process that started this one: process
 * trust, not token trust (see `src/api/mcp.ts`'s header). The allowlist is read
 * all the same — process trust says who may ask, never which hosts may be
 * crawled.
 *
 * `crawlDefaults` is deliberately not settable from the environment here for the
 * same reason `serve.ts` refuses it: the field an env var would eventually be
 * asked to carry is `allowPrivate`.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { closeDb, createDb } from "../db/client.js";
import { parseCredentialKeys, parseCredentialRetentionDays } from "../crawl/credential-vault.js";
import { loadMcpConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";

const config = loadMcpConfig();
// Before anything is constructed: a missing or malformed key is a boot error
// naming the variable, never a server that cannot store credentials (28b).
const credentialKeys = parseCredentialKeys(process.env);
const credentialRetentionDays = parseCredentialRetentionDays(process.env);
const db = createDb(config.databaseUrl);
const mcp = createMcpServer({
  db,
  config: {
    tenant: config.tenant,
    allowedDomains: config.allowedDomains,
    credentialKeys,
    credentialRetentionDays,
    // Undefined means each field's own default — `exports/` and `renders/`; see
    // `ServiceConfig`.
    ...(config.exportDir === undefined ? {} : { exportDir: config.exportDir }),
    ...(config.renderDir === undefined ? {} : { renderDir: config.renderDir }),
  },
});

await mcp.connect(new StdioServerTransport());
console.error(
  `ariadne mcp: serving on stdio for tenant ${config.tenant} — ` +
    `${config.allowedDomains.length} allowed domain(s)`,
);
// Stderr, like everything else here: stdout belongs to the protocol. An
// operator needs to know where `crawl_render` leaves its documents.
console.error(
  `ariadne mcp: rendered documents -> ${config.renderDir ?? "renders/ (default; set ARIADNE_RENDER_DIR to move it)"}`,
);
console.error(
  `ariadne mcp: crawl exports -> ${config.exportDir ?? "exports/ (default; set ARIADNE_EXPORT_DIR to move it)"}`,
);
if (config.allowedDomains.length === 0) {
  console.error(
    "ariadne mcp: the crawl allowlist is EMPTY — crawl_start will refuse every host " +
      "(set ARIADNE_ALLOWED_DOMAINS). The query tools are unaffected.",
  );
}

let shuttingDown = false;

/**
 * Close once, whatever asked: a signal, or the client hanging up.
 *
 * The crawl in flight is aborted rather than killed — the loop's graceful path
 * leaves the run `paused` (reason `shutdown`) with its frontier intact, so a
 * restart resumes it.
 */
function shutdown(why: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`ariadne mcp: ${why} — closing (a running crawl is paused (shutdown), not killed)`);
  mcp
    .close()
    .then(() => closeDb(db))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(`ariadne mcp: shutdown failed — ${String(error)}`);
      process.exit(1);
    });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}

/**
 * THE CLIENT HANGING UP IS A SHUTDOWN, and nothing else says so.
 *
 * On stdio the client's death arrives as EOF on our standard input and as
 * nothing else at all: no signal is sent to a child whose parent simply exits,
 * and the SDK's stdio transport does not subscribe to the stream's end. Without
 * this, a dropped pipe leaves this process alive holding the connection pool —
 * and, worse, still fetching a real site on behalf of a client that is gone,
 * which is a crawl nobody can stop and nobody is reading (rule 9).
 *
 * Both events are handled because they are not the same one: `end` fires when
 * the readable side is exhausted, `close` when the descriptor goes — a pipe that
 * is destroyed rather than ended can give the second without the first. The
 * guard inside `shutdown` makes the overlap harmless.
 */
process.stdin.on("end", () => shutdown("stdin closed (the client hung up)"));
process.stdin.on("close", () => shutdown("stdin closed (the client hung up)"));

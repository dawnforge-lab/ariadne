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
 * requires a database URL and reads the crawl allowlist, and asks for no bearer
 * token, because an stdio client is the process that started this one: process
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
import { loadMcpConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";

const config = loadMcpConfig();
const db = createDb(config.databaseUrl);
const mcp = createMcpServer({ db, config: { allowedDomains: config.allowedDomains } });

await mcp.connect(new StdioServerTransport());
console.error(
  `ariadne mcp: serving on stdio — ${config.allowedDomains.length} allowed domain(s)`,
);
if (config.allowedDomains.length === 0) {
  console.error(
    "ariadne mcp: the crawl allowlist is EMPTY — crawl_start will refuse every host " +
      "(set ARIADNE_ALLOWED_DOMAINS). The query tools are unaffected.",
  );
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`ariadne mcp: ${signal} — closing (a running crawl is cancelled, not killed)`);
    mcp
      .close()
      .then(() => closeDb(db))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`ariadne mcp: shutdown failed — ${String(error)}`);
        process.exit(1);
      });
  });
}

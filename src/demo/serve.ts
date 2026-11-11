/**
 * `npm run demo` — the local demo page and the API behind it, in one process.
 *
 * `api:serve`'s shape, with one deliberate difference and one deliberate
 * absence. The difference: this entrypoint sets `allowAnyPublicHost` (in
 * `createDemoServer`, its only production setter), because the page's point is
 * that a human types a URL and the crawl-trigger allowlist exists to forbid
 * exactly that. The absence: `crawlDefaults`, and therefore `allowPrivate`, is
 * never passed from here — the open allowlist is not an open SSRF perimeter,
 * `isUrlAllowed` still answers on every URL, and loopback and RFC1918 targets
 * stay refused (hard rule 5).
 *
 * That posture is only defensible because of the bind address below, which is
 * why it is hardcoded rather than an environment knob: an open allowlist on a
 * host anyone else can reach is a crawl-anything service with no auth in front
 * of it. There is no `ARIADNE_DEMO_HOST`, and adding one would undo the
 * reasoning that permits the posture at all.
 *
 * There are no output-directory knobs either. Renders and exports land in the
 * process's `renders/` and `exports/` defaults; a demo run from the repository
 * root is expected to leave its files there, and an operator who needs them
 * elsewhere wants `api:serve`, not this.
 */
import { closeDb, createDb } from "../db/client.js";
import { parseCredentialKeys } from "../crawl/credential-vault.js";
import { createDemoServer } from "./server.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL must be set (no fallback)");

// Every refusal happens before anything is constructed: a bad port must not
// leave a database pool behind on its way out.
const rawPort = process.env["ARIADNE_DEMO_PORT"];
const port = Number(rawPort ?? 8484);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`ARIADNE_DEMO_PORT is not a port: ${String(rawPort)}`);
}

// A boot error naming the variable when it is missing or malformed (28b): the
// demo accepts crawls, so it encrypts credentials like every other entrypoint.
const credentialKeys = parseCredentialKeys(process.env);
const db = createDb(databaseUrl);
const demo = createDemoServer({ db, credentialKeys });
// 127.0.0.1 is a decision, not a default: the demo's open-allowlist posture is
// only acceptable because nobody but this machine can reach the page.
const bound = await demo.listen(port, "127.0.0.1");
console.error(
  `ariadne demo: http://127.0.0.1:${bound.port}/ — open allowlist, url-policy enforced, allowPrivate OFF`,
);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`ariadne demo: ${signal} — closing (a running crawl is paused (shutdown), not killed)`);
    demo
      .close()
      .then(() => closeDb(db))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`ariadne demo: shutdown failed — ${String(error)}`);
        process.exit(1);
      });
  });
}

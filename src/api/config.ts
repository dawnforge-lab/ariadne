/**
 * What an API server instance is allowed to do, and who may ask it.
 *
 * Two controls, both required by the Talos seam (docs/talos-integration.md
 * obligation 2) and both present from the first line of the surface rather than
 * added later: a bearer token that says *who*, and a domain allowlist that says
 * *what*. An unattended agent holding the token still cannot point the crawler
 * at an arbitrary host.
 *
 * There is no "no token" mode and no "allow anything" mode. A tokenless boot
 * throws (see `loadApiConfig`), and an empty allowlist refuses every crawl
 * trigger while leaving queries readable — both are stated positions, not
 * defaults that happen to be permissive.
 */
import type { CrawlConfig } from "../crawl/loop.js";

/**
 * The construction config of one API server.
 *
 * `crawlDefaults` IS A PROCESS-TRUST SEAM AND IS DELIBERATELY NOT REACHABLE
 * FROM THE WIRE. It is code-level: whoever constructs the server is the process
 * that holds the database handle and the token, so it may set crawl fields the
 * HTTP surface refuses to accept from a client — `allowPrivate` above all,
 * which is how the test suite crawls its 127.0.0.1 fixture server and which a
 * request body may never carry (`parseStartCrawlInput` returns 400 if it is
 * present at all, per build-plan §7 item 3 and Task 1's persistence strip).
 *
 * The same trust model applies to the MCP transport (Task 4): MCP callers reach
 * the process over stdio and are therefore process-trusted, HTTP callers are
 * token-trusted, and the allowlist binds BOTH. What never happens is a network
 * client naming a field in this object.
 *
 * Precedence when a crawl is started: `CRAWL_DEFAULTS` (+ the API's own
 * `maxPages` default) < `crawlDefaults` < the request body's validated fields.
 * The request wins over the process default for everything the request is
 * allowed to say, which is every field except `allowPrivate`.
 */
export interface ApiServerConfig {
  /** Required. Compared constant-time against `Authorization: Bearer <token>`. */
  token: string;
  /**
   * Hosts a crawl may be pointed at. Exact host (`example.com`) or a subdomain
   * wildcard (`*.example.com`). An empty array refuses every crawl trigger.
   */
  allowedDomains: readonly string[];
  /** See the warning above. Code-level only; never wired to env or wire. */
  crawlDefaults?: Partial<CrawlConfig>;
  /**
   * Where `GET /crawls/:id/export` writes its files. Defaults to `exports/`
   * under the process's working directory.
   *
   * The directory is a server property rather than a request parameter, and
   * that is the whole point: a caller names a crawl and a dataset, never a
   * path. An API that took a destination from the wire would be a file-write
   * primitive with a bearer token in front of it. The response carries the
   * path the server chose so a human or a pipeline can pick the file up.
   */
  exportDir?: string;
  /**
   * Where the server writes its own diagnostics — a queue pick-up, a crawl that
   * threw, the stack behind a 500. Never the response body (a stack trace in a
   * tenant-visible response is obligation 6's failure). Defaults to
   * `console.error`.
   */
  log?: (line: string) => void;
}

/** Config read from the environment by the `api:serve` entrypoint. */
export interface LoadedApiConfig {
  token: string;
  allowedDomains: string[];
  port: number;
  databaseUrl: string;
}

/**
 * Shortest token this server will boot with.
 *
 * A guessable token on an unattended surface that can start crawls is not a
 * smaller version of the same protection — it is none. 16 characters is the
 * floor at which a random token stops being enumerable, and the refusal is at
 * boot where an operator sees it, not at the first request where an attacker
 * does.
 */
export const MIN_TOKEN_LENGTH = 16;

/** Default listen port for `npm run api:serve`. */
export const DEFAULT_API_PORT = 8787;

/**
 * Read the server's configuration from the environment, refusing to produce one
 * that would boot without auth.
 *
 * Every failure throws. There is no partial config and no "start read-only
 * because the token is missing" path: a surface that can trigger crawls booting
 * without a credential is exactly the silent fallback hard rule 7 forbids, and
 * the operator who set no token needs to be told, not accommodated.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): LoadedApiConfig {
  const token = (env["ARIADNE_API_TOKEN"] ?? "").trim();
  if (token === "") {
    throw new Error(
      "ARIADNE_API_TOKEN must be set: the API refuses to start without a bearer token",
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `ARIADNE_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters ` +
        `(got ${token.length}): a guessable token is not authentication`,
    );
  }

  const databaseUrl = (env["DATABASE_URL"] ?? "").trim();
  if (databaseUrl === "") {
    throw new Error("DATABASE_URL must be set: the API server holds the database handle");
  }

  const rawPort = (env["ARIADNE_API_PORT"] ?? "").trim();
  let port = DEFAULT_API_PORT;
  if (rawPort !== "") {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`ARIADNE_API_PORT is not a port number: ${rawPort}`);
    }
  }

  return {
    token,
    allowedDomains: parseAllowedDomains(env["ARIADNE_ALLOWED_DOMAINS"]),
    port,
    databaseUrl,
  };
}

/**
 * `ARIADNE_ALLOWED_DOMAINS` as a list: a comma-separated series of hosts, each
 * either exact (`example.com`) or a subdomain wildcard (`*.example.com`).
 *
 * Unset and empty both produce `[]`, which means "no crawl target is
 * permitted" — queries still work, crawl triggers are refused with a 403 that
 * says so. That is a usable posture (a read-only reporting instance), which is
 * why it is allowed to be the quiet case; what is NOT allowed is a malformed
 * entry, because "https://example.com/" in the list would silently match
 * nothing and the operator would believe the domain was permitted.
 */
export function parseAllowedDomains(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (entry === "") continue;
    assertAllowlistEntry(entry);
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function assertAllowlistEntry(entry: string): void {
  const bad = (why: string): never => {
    throw new Error(`ARIADNE_ALLOWED_DOMAINS entry '${entry}' ${why}`);
  };
  if (entry.includes("://") || entry.includes("/")) {
    bad("must be a bare host, not a URL");
  }
  if (/\s/.test(entry)) bad("must not contain whitespace");
  if (entry.includes("@")) bad("must not contain userinfo");
  if (entry === "*" || entry === "*.") bad("would allow every host: name the domains instead");
  const host = entry.startsWith("*.") ? entry.slice(2) : entry;
  if (host === "") bad("names no host");
  if (host.includes("*")) bad("may only use '*' as a leading '*.' label");
}

/**
 * Is `host` a crawl target this server permits?
 *
 * Matching is on the HOST ONLY — never the port, never the scheme, never a
 * path. `example.com` matches the string `example.com`; `*.example.com`
 * matches `a.example.com` and `a.b.example.com` but NOT `example.com` itself,
 * which is the standard reading of the wildcard and the one that lets an
 * operator permit the subdomains of a site without permitting its apex. List
 * both when both are wanted.
 *
 * WHAT AN ENTRY ACTUALLY AUTHORISES IS WIDER THAN ITS STRING, and an operator
 * needs to know that before writing one. This function answers about one
 * hostname; the crawler it gates does not work in hostnames, it works in
 * *sites*. Two consequences, both real:
 *
 *  - **The origin-variant family comes with the entry.** The crawl boundary is
 *    `isSameOrigin`, which treats `example.com` and `www.example.com`, and
 *    `http://` and `https://`, as one site — so permitting `example.com` and
 *    seeding a crawl there permits fetches to all four spellings. That is the
 *    engine's definition of "the same site", not a leak: a crawl that refused
 *    the www spelling of its own seed would crawl half of most sites. What it
 *    does NOT extend to is a *different* name: `shop.example.com` is another
 *    site and needs its own entry (or a wildcard).
 *  - **The host probe reaches further, and is gated separately.** It walks the
 *    variant family above plus every `legacyHosts` entry, before any robots.txt
 *    has been read. The extra hosts are checked against this allowlist one by
 *    one — see `checkLegacyHosts` in src/api/service.ts — precisely because
 *    they are outside the family an entry carries.
 *
 * Case is folded and a trailing root dot is stripped, because `Example.COM.`
 * and `example.com` are one host and a policy that could be stepped around by
 * spelling would not be a policy.
 */
export function isHostAllowed(host: string, allowed: readonly string[]): boolean {
  const needle = normaliseHost(host);
  if (needle === "") return false;
  for (const entry of allowed) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      if (needle.endsWith(suffix) && needle.length > suffix.length) return true;
      continue;
    }
    if (needle === entry) return true;
  }
  return false;
}

function normaliseHost(host: string): string {
  let h = host.trim().toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

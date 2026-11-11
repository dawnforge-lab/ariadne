/**
 * What an API server instance is allowed to do, and who may ask it.
 *
 * Two controls, both required by the Talos seam (docs/talos-integration.md
 * obligation 2) and both present from the first line of the surface rather than
 * added later: a bearer token that says *who*, and a domain allowlist that says
 * *what*. An unattended agent holding the token still cannot point the crawler
 * at an arbitrary host.
 *
 * There is no "no token" mode, and no configured deployment can open the
 * allowlist to everything. A tokenless boot throws (see `loadApiConfig`), and
 * an empty allowlist refuses every crawl trigger while leaving queries readable
 * — both are stated positions, not defaults that happen to be permissive. The
 * one open-allowlist posture that exists, `ServiceConfig.allowAnyPublicHost`,
 * is unreachable from the environment and from the wire and is a process-trust
 * seam like `crawlDefaults`: whoever constructs the server states it in code.
 */
import { domainToASCII } from "node:url";

import type { CredentialKeys } from "../crawl/credential-vault.js";
import type { CrawlConfig } from "../crawl/loop.js";
import type { AddressResolver } from "../crawl/url-policy.js";
import type { Timing } from "../worker/timing.js";
import { ServiceError } from "./errors.js";
import { parseTenant, type TenantId } from "../tenant.js";

/**
 * What one engine instance may do, whoever is asking: POLICY, not identity.
 *
 * This is the half of the configuration the service layer reads, and it is
 * deliberately separate from the bearer token below, because the two transports
 * differ on identity and agree on policy. `src/api/http.ts` authenticates a
 * network caller with a token; `src/api/mcp.ts` authenticates nobody, because
 * an MCP caller on stdio is the process that started this one (see
 * `loadMcpConfig`). Both construct an `ApiService` over this object, so the
 * allowlist binds BOTH transports and does so in ONE place — `startCrawl`,
 * where the crawl is accepted — rather than once per transport.
 *
 * `crawlDefaults` IS A PROCESS-TRUST SEAM AND IS DELIBERATELY NOT REACHABLE
 * FROM THE WIRE. It is code-level: whoever constructs the server is the process
 * that holds the database handle and the token, so it may set crawl fields the
 * surface refuses to accept from a client — `allowPrivate` above all, which is
 * how the test suite crawls its 127.0.0.1 fixture server and which a request
 * body (or an MCP tool argument) may never carry (`parseStartBody`
 * refuses it if it is present at all, per build-plan §7 item 3 and Task 1's
 * persistence strip).
 *
 * Precedence when a crawl is started: `CRAWL_DEFAULTS` (+ the API's own
 * `maxPages` default) < `crawlDefaults` < the request's validated fields. The
 * request wins over the process default for everything the request is allowed
 * to say, which is every field except `allowPrivate`.
 */
export interface ServiceConfig {
  /**
   * Hosts a crawl may be pointed at. Exact host (`example.com`) or a subdomain
   * wildcard (`*.example.com`). An empty array refuses every crawl trigger.
   */
  allowedDomains: readonly string[];
  /**
   * Accept ANY host at the crawl-trigger allowlist gate.
   *
   * THE SECOND PROCESS-TRUST SEAM, beside `crawlDefaults` below, and bound by
   * the same rule: code-level only, never wired to env or wire. `loadApiConfig`
   * does not read it, `serve.ts`/`mcp-serve.ts` never set it, and no request
   * field maps to it. It exists for the demo entrypoint (`src/demo/serve.ts`),
   * a local-only page whose point is "type any URL".
   *
   * It answers the ALLOWLIST question and nothing else. `isUrlAllowed` still
   * runs on every URL with `allowPrivate` from `crawlDefaults` alone, so
   * loopback and RFC1918 targets stay refused under this posture.
   */
  allowAnyPublicHost?: boolean;
  /** See the warning above. Code-level only; never wired to env or wire. */
  crawlDefaults?: Partial<CrawlConfig>;
  /**
   * TEST ONLY, and the third process-trust seam: the resolver the render
   * pass's browser pin approves the site's name through
   * (`RenderPassConfig.resolveAddress`). Absent, url-policy's DoH resolver.
   * A suite sets it so a render over a name that resolves nowhere, or whose
   * resolver fails, is answered without the network — and the same rule as
   * `crawlDefaults`: `loadApiConfig` does not read it, the entrypoints never
   * set it, no request field maps to it.
   */
  resolveAddress?: AddressResolver;
  /**
   * TEST ONLY, like `resolveAddress` and `RenderTestFaults`: awaited inside
   * `crawl_config_set` once the row and its credentials are written and the
   * transaction has not yet committed (`"written"`); a throw rolls both back.
   * `test/api/credential-vault.test.ts` throws from it to prove a refused
   * change leaves the stored credentials as they were. (The `"committed"`
   * phase went with the in-memory credential store in 28b: the values commit
   * with the row, so there is no window after the commit to hold open.)
   * `loadApiConfig` does not read it, the entrypoints never set it, and no
   * request field may ever map to it.
   */
  afterConfigWrite?: (phase: "written") => Promise<void>;
  /**
   * The keys crawl credentials are encrypted with (Phase 28b item 10;
   * `src/crawl/credential-vault.ts`). Required: every process that accepts or
   * runs crawls holds them, and the entrypoints read them from
   * `ARIADNE_CREDENTIALS_KEY` (and `ARIADNE_CREDENTIALS_KEY_PREVIOUS`) with
   * `parseCredentialKeys`, which refuses to boot without a well-formed key.
   */
  credentialKeys: CredentialKeys;
  /**
   * How many days a settled crawl keeps its stored credentials before the
   * retention sweep deletes them (`CredentialVault.sweepExpired`). A positive
   * whole number; 30 when absent. The entrypoints read it from
   * `ARIADNE_CREDENTIALS_RETENTION_DAYS` (`parseCredentialRetentionDays`).
   */
  credentialRetentionDays?: number;
  /**
   * Where `GET /crawls/:id/export` (and the MCP `export_crawl` tool) writes its
   * files. Defaults to `exports/` under the process's working directory, and the
   * `api:serve` / `mcp:serve` entrypoints let an operator move it with
   * `ARIADNE_EXPORT_DIR`.
   *
   * The directory is a server property rather than a request parameter, and
   * that is the whole point: a caller names a crawl and a dataset, never a
   * path. An API that took a destination from the wire would be a file-write
   * primitive with a bearer token in front of it. The response carries the
   * path the server chose so a human or a pipeline can pick the file up.
   *
   * `renderDir`'s twin, and settable for the same reason: on a billed audit the
   * export is the NORMAL path rather than the exception (the action-plan skill
   * switches to it past 2,000 rows, and an uncapped crawl passes that on its
   * first large rule), so the files accumulate wherever the process was started.
   * The Phase 8 gate is the measurement: a skills-only deliverable run left
   * 384,526 bytes of one crawl's findings in the repository's own `exports/`
   * while the renders — already movable — went where the operator asked.
   */
  exportDir?: string;
  /**
   * Where `POST /crawls/:id/render` (and the MCP `crawl_render` tool) keeps the
   * serialised post-JavaScript documents its pass produces — one directory per
   * crawl underneath it. Defaults to `renders/` under the process's working
   * directory (`RENDER_HTML_DIR`), and the `api:serve` / `mcp:serve`
   * entrypoints let an operator move it with `ARIADNE_RENDER_DIR`.
   *
   * `exportDir`'s twin in every way that matters, and settable for the same
   * reason plus one more. Like exports, it is a SERVER property and never a
   * request parameter — a caller names a crawl, never a path. Unlike exports,
   * it also grows without being asked to: every rendered page leaves a file
   * behind, so an operator who cannot say where they land ends up with a crawl's
   * evidence in whatever directory the process happened to start in. That is
   * how this repository's own test suite left twelve stray crawl directories in
   * the working tree before this field existed.
   */
  renderDir?: string;
  /**
   * Who runs the crawls this service accepts (Phase 28b):
   *
   *  - `"in-process"` (the default): the service owns a `JobRunner` and runs
   *    them itself, one at a time — the crawl jobs it accepts are pinned to its
   *    own instance and it runs only those. Today's behaviour, the local MCP
   *    server's, and every test's.
   *  - `"workers"`: crawl jobs are left unpinned for the worker processes
   *    (`worker:serve`, Task 5) and this service runs none. `api:serve` sets it.
   *
   * Either way `crawl_render` and `crawl_rules` run synchronously here, under a
   * job pinned to this process.
   */
  crawlRunner?: "in-process" | "workers";
  /**
   * The worker clock this service runs on (src/worker/timing.ts): how often it
   * heartbeats its instance, and how long a silent instance stays live for the
   * "held" questions (`queuePosition`, `crawl_mark_failed`, `crawl_resume`).
   * Code-only, like `crawlDefaults`: the entrypoints never set it from the
   * environment; a test injects a short clock.
   */
  timing?: Partial<Timing>;
  /**
   * Where the server writes its own diagnostics — a queue pick-up, a crawl that
   * threw, the stack behind a 500. Never the response body (a stack trace in a
   * tenant-visible response is obligation 6's failure). Defaults to
   * `console.error`.
   */
  log?: (line: string) => void;
}

/**
 * The construction config of one HTTP API server: the policy above, plus the
 * credential that says *who* is asking.
 *
 * The token is the HTTP transport's alone. It is not a service-layer concern
 * and never was — `ApiService` does not read it — which is why the split
 * exists: the MCP transport needs every field of `ServiceConfig` and none of
 * this one, and an `ApiServerConfig` is still accepted anywhere a
 * `ServiceConfig` is wanted.
 */
export interface ApiServerConfig extends ServiceConfig {
  /** Required. Compared constant-time against `Authorization: Bearer <token>`. */
  token: string;
}

/**
 * The stdio MCP transport's configuration: one tenant per process (Phase 28a).
 *
 * Over HTTP the tenant is a request header, read per request; an stdio server
 * has one client — the process that started it — so the tenant is fixed at boot
 * (`ARIADNE_TENANT`) and every tool call is made with it. Required, with no
 * default: a server that named no tenant would own no crawl.
 */
export interface McpServerConfig extends ServiceConfig {
  tenant: TenantId;
}

/** Config read from the environment by the `api:serve` entrypoint. */
export interface LoadedApiConfig {
  token: string;
  allowedDomains: string[];
  port: number;
  databaseUrl: string;
  /** `ARIADNE_EXPORT_DIR`, or undefined for the `exports/` default. */
  exportDir: string | undefined;
  /** `ARIADNE_RENDER_DIR`, or undefined for the `renders/` default. */
  renderDir: string | undefined;
}

/** Config read from the environment by the `mcp:serve` entrypoint. */
export interface LoadedMcpConfig {
  /** `ARIADNE_TENANT`: required, through `parseTenant`. */
  tenant: TenantId;
  allowedDomains: string[];
  databaseUrl: string;
  /** `ARIADNE_EXPORT_DIR`, or undefined for the `exports/` default. */
  exportDir: string | undefined;
  /** `ARIADNE_RENDER_DIR`, or undefined for the `renders/` default. */
  renderDir: string | undefined;
}

/**
 * `ARIADNE_EXPORT_DIR` / `ARIADNE_RENDER_DIR` as the service reads them: a path,
 * or nothing.
 *
 * ONE function for both variables because they are one decision — where this
 * server's own output lands — and the two settings must not drift apart in how
 * they read a shell. Both are safe environment knobs for the same reason
 * `crawlDefaults` is not one: they name where our files go, never what the
 * server may do.
 *
 * Unset and empty are the SAME answer — "use the default" — and each default is
 * named in its own `ServiceConfig` field rather than repeated here. This is not
 * the `ARIADNE_ALLOWED_DOMAINS` case where an unset value is a stated posture: a
 * missing directory setting cannot silently permit anything, it can only put
 * files somewhere predictable, so a default is the honest answer instead of a
 * refusal. Neither is validated for existence or writability at boot: the write
 * path creates the directory, and a boot-time check would be a claim about a
 * filesystem that can change before the first write anyway (hard rule 7 — the
 * failure is loud where it happens).
 */
export function parseOutputDir(raw: string | undefined): string | undefined {
  const dir = (raw ?? "").trim();
  return dir === "" ? undefined : dir;
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
    exportDir: parseOutputDir(env["ARIADNE_EXPORT_DIR"]),
    renderDir: parseOutputDir(env["ARIADNE_RENDER_DIR"]),
  };
}

/**
 * Read the MCP server's configuration from the environment.
 *
 * TWO DELIBERATE DIFFERENCES FROM `loadApiConfig`, and both are the trust model
 * rather than convenience:
 *
 *  - **No token, and none is invented.** The MCP transport this repo ships is
 *    stdio: the client speaks to this process over its own standard input,
 *    which means the client either started it or was handed its pipes. That is
 *    process trust, and it is the same trust `crawlDefaults` already rests on.
 *    A bearer token here would authenticate the caller to itself — a ritual,
 *    not a control — and the *real* control is that the process holds the
 *    database handle. `ARIADNE_API_TOKEN` is ignored (not refused: one
 *    environment usually configures both entrypoints).
 *
 *    This stops being true the moment the server is mounted on a network
 *    transport. If that day comes, authentication is not optional and does not
 *    belong in this function's silence.
 *
 *  - **The allowlist is still read, and is still allowed to be empty.** Process
 *    trust says who may ask; it says nothing about which hosts may be crawled,
 *    and obligation 2 binds both transports. An empty list is the same stated
 *    posture it is over HTTP — every crawl trigger refused, every query
 *    answered — and `createMcpServer` says so on stderr at boot.
 *
 * `DATABASE_URL` is required for the same reason as over HTTP: the server holds
 * the database handle, and there is nothing to answer without one.
 */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): LoadedMcpConfig {
  const databaseUrl = (env["DATABASE_URL"] ?? "").trim();
  if (databaseUrl === "") {
    throw new Error("DATABASE_URL must be set: the MCP server holds the database handle");
  }
  return {
    tenant: parseTenantEnv(env["ARIADNE_TENANT"]),
    allowedDomains: parseAllowedDomains(env["ARIADNE_ALLOWED_DOMAINS"]),
    databaseUrl,
    exportDir: parseOutputDir(env["ARIADNE_EXPORT_DIR"]),
    renderDir: parseOutputDir(env["ARIADNE_RENDER_DIR"]),
  };
}

/**
 * `ARIADNE_TENANT` as a tenant, or a boot error. No default and no trim — the
 * same `parseTenant` the HTTP header goes through — and the error names the
 * variable and the rule, never the value set (it may be a key pasted into the
 * wrong variable).
 */
function parseTenantEnv(raw: string | undefined): TenantId {
  try {
    return parseTenant(raw);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    throw new Error(
      error.code === "TENANT_REQUIRED"
        ? "ARIADNE_TENANT must be set: the MCP server acts for one tenant, and there is no default"
        : `ARIADNE_TENANT is not a valid tenant: ${error.message}`,
    );
  }
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
    const spelling = part.trim().toLowerCase();
    // An empty segment is a trailing comma or a double one — punctuation, not
    // an entry. A segment holding only dots is NOT empty and is not skipped
    // here; it reaches `assertAllowlistEntry` and is refused by name.
    if (spelling === "") continue;
    // The trailing root dot is stripped for the same reason `normaliseHost`
    // strips it from the needle: `example.com.` and `example.com` are one host.
    // This side used to keep it, and the asymmetry was silent — an entry
    // written with the root dot could never equal a needle written without it,
    // so the operator's domain matched nothing while looking permitted.
    const entry = normaliseHost(spelling);
    assertAllowlistEntry(entry, spelling);
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * `spelling` is what the operator actually typed, and it is what the messages
 * quote: an entry normalised to `''` needs to be reported as the `'.'` it was
 * written as, or the error names nothing.
 */
function assertAllowlistEntry(entry: string, spelling: string = entry): void {
  const bad = (why: string): never => {
    throw new Error(`ARIADNE_ALLOWED_DOMAINS entry '${spelling}' ${why}`);
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

  // NON-ASCII IS REFUSED, and this is the quiet-failure class the whole
  // function exists for. Every needle this list is matched against comes out of
  // `new URL(...).hostname`, which is IDNA-encoded: `münchen.de` reaches
  // `isHostAllowed` as `xn--mnchen-3ya.de`. A Unicode entry can therefore never
  // equal any needle and never suffix-match one — it permits exactly nothing,
  // while an operator reading their own domain back out of the config believes
  // it is allowed and cannot see why every crawl of it is refused.
  //
  // The punycode spelling is named rather than described, because the fix is
  // then a copy-paste. `domainToASCII` returns '' on a label it cannot convert;
  // the entry is refused either way, and the message says which case it is.
  if ([...host].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)) {
    const ascii = domainToASCII(host);
    if (ascii === "") {
      bad("is not an ASCII hostname and cannot be converted to one: hosts are matched " +
        "in their IDNA (punycode) form, so this entry would permit nothing");
    }
    bad(
      "is not ASCII: hosts are matched in their IDNA (punycode) form, so this entry " +
        `would permit nothing. Write it as '${entry.startsWith("*.") ? `*.${ascii}` : ascii}'`,
    );
  }
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
 * spelling would not be a policy. BOTH SIDES are normalised the same way — the
 * needle here, the entries in `parseAllowedDomains` — which was the point of
 * the fix that made it true: normalising only the needle meant an entry written
 * `example.com.` matched nothing at all.
 *
 * The needle also arrives IDNA-encoded, because it comes from
 * `new URL(...).hostname`. Entries are refused unless they are ASCII, so the
 * two sides are always in the same alphabet (see `assertAllowlistEntry`).
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

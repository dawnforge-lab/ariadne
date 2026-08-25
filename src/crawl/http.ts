/**
 * The HTTP plumbing every network path in the crawler shares: the connection
 * pools, the connect-time address guard that closes the DNS-rebind window, the
 * capped body reader, charset decoding, and the error-classification helpers.
 *
 * Extracted from fetch-page (P1-T4) when discovery (P1-T5) needed the same
 * discipline for robots.txt and sitemaps — documents that are not HTML pages
 * and so cannot go through `fetchPage`, but which are network I/O like any
 * other and must not get a second, weaker connect guard. One definition of the
 * guard, one set of pools; the differences (body caps, classification) live in
 * the callers.
 */
import { lookup as systemLookup, type LookupOptions } from "node:dns";
import { Agent } from "undici";
import { blockedAddressReason } from "./url-policy.js";

/**
 * A constant, not the caller's `timeoutMs`, because it is baked into the
 * shared pool's connector. The per-request deadline still bounds a slow
 * connect: aborting the request aborts the connect attempt with it.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Error code the socket lookup hook stamps on a connect-time refusal. */
export const BLOCKED_ADDRESS_CODE = "ARIADNE_BLOCKED_ADDRESS";

export interface LookupAddress {
  address: string;
  family: number;
}

/**
 * Node's shape exactly: on the error path the address argument is ignored, so
 * callers pass `""` rather than making the parameter optional (an optional
 * parameter makes this type unassignable to `net.LookupFunction`).
 */
export type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  addressOrAddresses: string | LookupAddress[],
  family?: number,
) => void;

/** The `dns.lookup` shape `net.connect` expects. */
export type DnsLookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: DnsLookupCallback,
) => void;

/**
 * Wraps a resolver so every address it returns is policy-checked *before*
 * `net.connect` opens the socket. This is the wall url-policy's facade is not:
 * a public hostname with a private A record (metadata.goog -> 169.254.169.254)
 * passes the string-level check and dies here instead. Because the check sits
 * on the same resolution the socket then uses, it also closes the DNS-rebind
 * window — there is no second lookup between verdict and connect.
 *
 * Refusal is "any", not "all": one blocked answer among several refuses the
 * host, matching url-policy's mixed-answer rule.
 */
export function guardedLookup(base: DnsLookupFn, allowPrivate: boolean): DnsLookupFn {
  return (hostname, options, callback) => {
    // Always ask for every answer: checking only the address net.connect
    // happens to pick would leave the others unexamined on a retry.
    base(hostname, { ...options, all: true }, (err, result) => {
      if (err) {
        callback(err, "");
        return;
      }
      const addresses = Array.isArray(result) ? result : [];
      if (addresses.length === 0) {
        const empty: NodeJS.ErrnoException = new Error(
          `no addresses resolved for ${hostname}`,
        );
        empty.code = "ENOTFOUND";
        callback(empty, "");
        return;
      }

      for (const entry of addresses) {
        const reason = blockedAddressReason(entry.address, { allowPrivate });
        if (reason !== null) {
          const refusal: NodeJS.ErrnoException = new Error(
            `${hostname} resolves to ${entry.address}: ${reason}`,
          );
          refusal.code = BLOCKED_ADDRESS_CODE;
          callback(refusal, "");
          return;
        }
      }

      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      // Guaranteed present by the length check above; reported as a failed
      // lookup rather than thrown, because a throw inside a dns callback is an
      // uncaught exception, not a classified fetch.
      const first = addresses[0];
      if (first === undefined) {
        const missing: NodeJS.ErrnoException = new Error(
          `no usable address for ${hostname}`,
        );
        missing.code = "ENOTFOUND";
        callback(missing, "");
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

export function newAgent(allowPrivate: boolean, base: DnsLookupFn): Agent {
  // undici forwards its `connect` options to net.connect / tls.connect, which
  // is how the guarded resolver reaches the socket.
  return new Agent({
    connect: {
      timeout: CONNECT_TIMEOUT_MS,
      lookup: guardedLookup(base, allowPrivate),
    },
  });
}

/**
 * Exactly two shared pools, one per address policy, so keep-alive survives
 * between fetches and the connection count stays O(concurrency) rather than
 * O(URLs). Nothing per-request is baked into a pool — that is why the connect
 * timeout is a constant and the caller's `timeoutMs` is enforced per request
 * instead. A caller-supplied `lookup` gets a throwaway agent (tests only),
 * because the resolver *is* baked into the connector.
 */
const sharedAgents = new Map<string, Agent>();

export function sharedAgent(allowPrivate: boolean): Agent {
  const key = allowPrivate ? "private" : "public";
  const existing = sharedAgents.get(key);
  if (existing !== undefined) return existing;
  // Always the system resolver: a pooled agent outlives the call that created
  // it, so taking the resolver from the caller would hand the next caller
  // somebody else's DNS.
  const created = newAgent(allowPrivate, systemLookup as DnsLookupFn);
  sharedAgents.set(key, created);
  return created;
}

/** Closes the shared pools. For process shutdown and test teardown. */
export async function closeFetchAgents(): Promise<void> {
  const agents = [...sharedAgents.values()];
  sharedAgents.clear();
  await Promise.all(agents.map((agent) => agent.close()));
}

export type HeaderBag = Record<string, string | string[] | undefined>;

export function headerValue(headers: HeaderBag, name: string): string | null {
  const raw = headers[name];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? raw.join(", ") : raw;
}

export function mimeType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const value = contentType.split(";")[0]?.trim().toLowerCase();
  return value === undefined || value === "" ? null : value;
}

function charsetOf(contentType: string | null): string | null {
  if (contentType === null) return null;
  const match = contentType.match(/;\s*charset\s*=\s*"?([^";]+)"?/i);
  return match === null ? null : (match[1] ?? "").trim() || null;
}

/**
 * Decode with the declared charset, defaulting to utf-8.
 *
 * Two deliberate non-fatal paths, neither of them a hidden error: a charset
 * label Node's ICU does not know (`charset=not-a-real-charset`) decodes as
 * utf-8, and bytes that are malformed in the chosen encoding become U+FFFD
 * rather than throwing. Both are what a browser does, and both keep the page
 * classified on its HTTP facts. A page whose bytes we cannot read is still a
 * page the rules should see; throwing here would turn a target-site defect
 * into a crawler crash.
 */
export function decodeBody(bytes: Buffer, contentType: string | null): string {
  const label = charsetOf(contentType) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export interface CappedBody {
  bytes: number;
  buffer: Buffer | null;
  truncated: boolean;
}

/**
 * Read at most `maxBytes`. Under the cap the stream is drained to the end so
 * the socket returns to the pool; over it, the stream is destroyed, which
 * aborts the request — we will not pay for the rest of a 2GB response.
 * `keep` is false when the caller has already decided to discard the body
 * (non-HTML, redirects): the bytes are still counted and drained, never held.
 */
export async function readCapped(
  body: AsyncIterable<Buffer> & { destroy: (error?: Error) => void },
  maxBytes: number,
  keep: boolean,
): Promise<CappedBody> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  for await (const chunk of body) {
    const remaining = maxBytes - bytes;
    if (chunk.byteLength > remaining) {
      if (keep && remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes = maxBytes;
      truncated = true;
      break;
    }
    if (keep) chunks.push(chunk);
    bytes += chunk.byteLength;
  }

  if (truncated) body.destroy();
  return {
    bytes,
    buffer: keep ? Buffer.concat(chunks) : null,
    truncated,
  };
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** The connect-time refusal message, if this error is one. */
export function blockedAddressMessage(error: unknown): string | null {
  for (const link of errorChain(error)) {
    if (errorCode(link) === BLOCKED_ADDRESS_CODE) {
      return link instanceof Error ? link.message : String(link);
    }
  }
  return null;
}

const TIMEOUT_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
]);

export function isTimeout(error: unknown): boolean {
  return errorChain(error).some((link) => {
    const code = errorCode(link);
    return code !== null && TIMEOUT_CODES.has(code);
  });
}

/**
 * Errors that are ours, not the target site's: undici's InvalidArgumentError
 * (a malformed user agent, a bad option) and any TypeError out of our own
 * misuse. These must not be classified — a newline in the configured user
 * agent would otherwise write 50k `network_error` rows for a one-line bug in
 * our config. "Nothing throws for a target-site problem" is the contract;
 * this is the other side of it.
 */
export function isProgrammerError(error: unknown): boolean {
  return errorChain(error).some(
    (link) => link instanceof TypeError || errorCode(link) === "UND_ERR_INVALID_ARG",
  );
}

/** A short, human-readable summary of a failed request. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = errorCode(error);
    return code === null ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

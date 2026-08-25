/**
 * Adapted from open-seo (MIT), src/server/lib/audit/url-policy.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 * Changes: removed app-framework imports (AppError -> local UrlPolicyError);
 * added isUrlAllowed() facade; private-range checks kept; test-only
 * allowPrivate escape hatch. Further changes, each explained at its call site:
 *  - IPv6 classification rewritten. Upstream matched string prefixes
 *    ("::1", "fc", "fd", "fe8".."feb", "::ffff:") which misses every
 *    uncompressed spelling (0:0:0:0:0:ffff:7f00:1), the IPv4-compatible form
 *    (::127.0.0.1) and the NAT64 prefix (64:ff9b::7f00:1). Replaced with a
 *    full 16-byte parser plus a 2000::/3 global-unicast allowlist.
 *  - IPv4 literal parsing tightened to a strict dotted quad (upstream's
 *    Number() coercion read "10..0.1" as 10.0.0.1 and "0x7f.0.0.1" as
 *    127.0.0.1; WHATWG URL canonicalises those before we ever see them).
 *  - DoH resolution failures throw DNS_RESOLUTION_FAILED instead of being
 *    swallowed as "not blocked" (project rule: no silent fallbacks).
 *  - The DoH resolver is injectable so tests never touch the network.
 *  - resolveStartUrlRedirects validates its input before the first probe and
 *    sends Ariadne's user agent.
 *  - The test-only allowPrivate escape hatch has a floor it cannot lift:
 *    cloud metadata hosts and 169.254.0.0/16 stay refused.
 */

/** Hosts that are never crawlable, whatever they resolve to. */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
];

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 2_500;
const DNS_STATUS_NOERROR = 0;
const DNS_STATUS_NXDOMAIN = 3;

export type UrlPolicyErrorCode =
  | "VALIDATION_ERROR"
  | "CRAWL_TARGET_BLOCKED"
  | "DNS_RESOLUTION_FAILED";

/**
 * Replaces upstream's framework `AppError`. The `code` field is deliberately
 * shaped like upstream's so callers (and the absorbed tests) can match on it.
 */
export class UrlPolicyError extends Error {
  readonly code: UrlPolicyErrorCode;

  constructor(code: UrlPolicyErrorCode, message?: string) {
    super(message ?? code);
    this.name = "UrlPolicyError";
    this.code = code;
  }
}

/**
 * Lowercase, unbracket ([::1] -> ::1), drop an IPv6 zone id (fe80::1%eth0)
 * and drop a fully-qualifying trailing dot (example.com. -> example.com).
 */
function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  const zoneAt = host.indexOf("%");
  if (zoneAt !== -1) {
    host = host.slice(0, zoneAt);
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host;
}

/**
 * Strict dotted quad only. Anything else is not an IPv4 literal as far as this
 * module is concerned — which is safe because every host reaching us has been
 * through WHATWG `URL` (which canonicalises octal/hex/integer forms to dotted
 * quad, or rejects them) or is a DoH answer (always canonical).
 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Loopback, private, CGNAT, link-local (incl. the cloud metadata address),
 * benchmarking, multicast and reserved space. Ranges are upstream's.
 */
function ipv4Reason(octets: number[]): string | null {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;

  if (a === 0) return "reserved IPv4 address (0.0.0.0/8)";
  if (a === 10) return "private IPv4 address (10.0.0.0/8)";
  if (a === 127) return "loopback IPv4 address (127.0.0.0/8)";
  if (a === 169 && b === 254) {
    return "link-local IPv4 address (169.254.0.0/16)";
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return "private IPv4 address (172.16.0.0/12)";
  }
  if (a === 192 && b === 168) return "private IPv4 address (192.168.0.0/16)";
  if (a === 100 && b >= 64 && b <= 127) {
    return "carrier-grade NAT IPv4 address (100.64.0.0/10)";
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return "benchmarking IPv4 address (198.18.0.0/15)";
  }
  if (a >= 224) return "multicast or reserved IPv4 address (224.0.0.0/3)";
  return null;
}

/**
 * Full IPv6 literal -> 16 bytes, or null when the string is not an IPv6
 * literal. Handles "::" compression once, and an embedded IPv4 tail
 * (::ffff:127.0.0.1). Written out rather than prefix-matched so that every
 * spelling of the same address classifies identically.
 */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;

  const doubleColonAt = host.indexOf("::");
  if (doubleColonAt !== host.lastIndexOf("::")) return null;

  const head = doubleColonAt === -1 ? host : host.slice(0, doubleColonAt);
  const tail = doubleColonAt === -1 ? "" : host.slice(doubleColonAt + 2);
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");

  // An embedded IPv4 tail may only be the final group of the whole address.
  const groups = [...headGroups, ...tailGroups];
  for (let i = 0; i < groups.length - 1; i++) {
    if ((groups[i] ?? "").includes(".")) return null;
  }
  if (doubleColonAt !== -1 && (headGroups.at(-1) ?? "").includes(".")) {
    return null;
  }

  const headBytes = groupsToBytes(headGroups);
  const tailBytes = groupsToBytes(tailGroups);
  if (headBytes === null || tailBytes === null) return null;

  const present = headBytes.length + tailBytes.length;
  if (doubleColonAt === -1) {
    return present === 16 ? headBytes : null;
  }
  // "::" must stand for at least one elided 16-bit group.
  if (present > 14) return null;
  const zeros = new Array<number>(16 - present).fill(0);
  return [...headBytes, ...zeros, ...tailBytes];
}

function groupsToBytes(groups: string[]): number[] | null {
  const bytes: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] ?? "";
    if (i === groups.length - 1 && group.includes(".")) {
      const embedded = parseIpv4(group);
      if (embedded === null) return null;
      bytes.push(...embedded);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/** The IPv4 inside ::ffff:0:0/96, or null. */
function mappedIpv4(bytes: number[]): number[] | null {
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return bytes.slice(12, 16);
}

/**
 * Allowlist rather than denylist: only 2000::/3 (global unicast) is crawlable.
 * That refuses ::1, ::, ::a.b.c.d, fc00::/7, fe80::/10, fec0::/10, ff00::/8
 * and 64:ff9b::/96 in every spelling, without enumerating them. IPv4-mapped
 * addresses defer to the IPv4 policy so ::ffff:127.0.0.1 is refused while a
 * mapped public address is not.
 */
function ipv6Reason(bytes: number[]): string | null {
  const mapped = mappedIpv4(bytes);
  if (mapped !== null) {
    const reason = ipv4Reason(mapped);
    return reason === null ? null : `IPv4-mapped ${reason}`;
  }
  if (((bytes[0] ?? 0) & 0xe0) === 0x20) return null;
  return "non-global IPv6 address (loopback, link-local, unique-local, multicast or reserved)";
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || host.includes(":");
}

/**
 * The reason this host may not be crawled, or null when it may be.
 * Upstream returned a bare boolean; the reason travels into the verdict so a
 * refusal is never a silent "false".
 */
export function blockedHostReason(hostname: string): string | null {
  const host = normalizeHost(hostname);
  if (!host) return "empty host";
  if (BLOCKED_HOSTS.has(host)) return `blocked host name (${host})`;
  const suffix = BLOCKED_HOST_SUFFIXES.find((s) => host.endsWith(s));
  if (suffix !== undefined) return `internal host suffix (${suffix})`;

  if (isIpLiteral(host)) {
    const v4 = parseIpv4(host);
    if (v4 !== null) return ipv4Reason(v4);
    const v6 = parseIpv6(host);
    if (v6 !== null) return ipv6Reason(v6);
    return "unparseable IP literal";
  }

  return null;
}

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

type DnsJsonResponse = {
  Status?: number;
  Answer?: DnsJsonAnswer[];
};

/** Resolves a hostname to address literals. Injected so tests stay offline. */
export type AddressResolver = (
  hostname: string,
  type: "A" | "AAAA",
) => Promise<string[]>;

/**
 * DNS-over-HTTPS lookup. A transport failure or a DNS status other than
 * NOERROR/NXDOMAIN throws: we must not treat "could not check" as "not
 * blocked" — that is the silent fallback the project forbids, and it is
 * exactly the case an SSRF probe would try to provoke.
 */
export const resolveViaDoh: AddressResolver = async (hostname, type) => {
  let response: Response;
  try {
    response = await fetch(
      `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      },
    );
  } catch (cause) {
    throw new UrlPolicyError(
      "DNS_RESOLUTION_FAILED",
      `DoH ${type} lookup for ${hostname} failed: ${String(cause)}`,
    );
  }

  if (!response.ok) {
    throw new UrlPolicyError(
      "DNS_RESOLUTION_FAILED",
      `DoH ${type} lookup for ${hostname} returned HTTP ${response.status}`,
    );
  }

  let body: DnsJsonResponse;
  try {
    body = (await response.json()) as DnsJsonResponse;
  } catch (cause) {
    throw new UrlPolicyError(
      "DNS_RESOLUTION_FAILED",
      `DoH ${type} lookup for ${hostname} returned an unreadable body: ${String(cause)}`,
    );
  }
  if (body.Status === DNS_STATUS_NXDOMAIN) return [];
  if (body.Status !== DNS_STATUS_NOERROR) {
    throw new UrlPolicyError(
      "DNS_RESOLUTION_FAILED",
      `DoH ${type} lookup for ${hostname} returned DNS status ${String(body.Status)}`,
    );
  }
  if (!Array.isArray(body.Answer)) return [];

  const expectedType = type === "A" ? 1 : 28;
  return body.Answer.filter(
    (answer): answer is Required<Pick<DnsJsonAnswer, "data" | "type">> =>
      answer.type === expectedType && typeof answer.data === "string",
  ).map((answer) => normalizeHost(answer.data));
};

/**
 * True when any A/AAAA answer points into blocked space. "Any", not "all":
 * a host with one public and one private answer is refused (Talos SSRF
 * parity — mixed answers are refused, see docs/talos-integration.md §5).
 */
async function hostnameResolvesToBlockedAddress(
  hostname: string,
  resolve: AddressResolver,
): Promise<boolean> {
  const host = normalizeHost(hostname);
  if (!host || isIpLiteral(host)) return false;

  const [v4, v6] = await Promise.all([resolve(host, "A"), resolve(host, "AAAA")]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) return false;

  return addresses.some((address) => blockedHostReason(address) !== null);
}

/**
 * Synchronous SSRF check for URLs discovered mid-crawl (links, redirect
 * targets, sitemap entries). Blocks non-http(s) schemes, private/loopback IP
 * literals, and internal hostnames. DNS resolution is only performed for the
 * start URL (see normalizeAndValidateStartUrl); per-link DoH lookups would be
 * prohibitively slow.
 */
export function isCrawlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return blockedHostReason(parsed.hostname) === null;
}

export interface UrlVerdict {
  allowed: boolean;
  reason: string | null;
}

export interface UrlPolicyOpts {
  /**
   * TEST ONLY. Admits loopback/private targets so the suite can crawl a
   * 127.0.0.1 fixture server. Never wire this to crawl config, an API field
   * or an env var — the only callers are tests. Cloud metadata endpoints stay
   * refused even here (see hardBlockedReason).
   */
  allowPrivate?: boolean;
}

/**
 * The floor the test-only allowPrivate escape hatch cannot lift. If
 * allowPrivate ever leaks out of the test suite, the crawler still cannot
 * reach a cloud metadata service — the payload of almost every real SSRF.
 */
function hardBlockedReason(host: string): string | null {
  if (host !== "localhost" && BLOCKED_HOSTS.has(host)) {
    return `blocked host name (${host})`;
  }
  const v4 = parseIpv4(host);
  if (v4 !== null && v4[0] === 169 && v4[1] === 254) {
    return "link-local IPv4 address (169.254.0.0/16)";
  }
  return null;
}

/**
 * The seam every fetch path calls, on every URL, before every request —
 * discovered, redirected-to, or supplied by a client. Async by contract
 * (callers already await it) but deliberately does no DNS: per-hop DoH would
 * make the crawl loop unusable. Hostname-level SSRF (a public name pointing at
 * private space) is checked once per hop on the start URL by
 * normalizeAndValidateStartUrl / resolveStartUrlRedirects, and each redirect
 * hop the crawl loop enqueues comes back through here.
 */
export async function isUrlAllowed(
  url: string,
  opts: UrlPolicyOpts = {},
): Promise<UrlVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `unparseable URL (${url})` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `unsupported scheme (${parsed.protocol})` };
  }

  const host = normalizeHost(parsed.hostname);
  if (!host) return { allowed: false, reason: "empty host" };

  const reason =
    opts.allowPrivate === true
      ? hardBlockedReason(host)
      : blockedHostReason(host);
  return reason === null
    ? { allowed: true, reason: null }
    : { allowed: false, reason };
}

export interface StartUrlOpts {
  /** Injected in tests; defaults to the real DoH resolver. */
  resolve?: AddressResolver;
}

export async function normalizeAndValidateStartUrl(
  input: string,
  opts: StartUrlOpts = {},
): Promise<string> {
  const resolve = opts.resolve ?? resolveViaDoh;

  let raw = input.trim();
  if (!raw) throw new UrlPolicyError("VALIDATION_ERROR", "empty start URL");

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlPolicyError("VALIDATION_ERROR", `unparseable start URL: ${input}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlPolicyError(
      "VALIDATION_ERROR",
      `unsupported scheme: ${parsed.protocol}`,
    );
  }

  const reason = blockedHostReason(parsed.hostname);
  if (reason !== null) {
    throw new UrlPolicyError(
      "CRAWL_TARGET_BLOCKED",
      `${parsed.hostname}: ${reason}`,
    );
  }

  if (await hostnameResolvesToBlockedAddress(parsed.hostname, resolve)) {
    throw new UrlPolicyError(
      "CRAWL_TARGET_BLOCKED",
      `${parsed.hostname} resolves into blocked address space`,
    );
  }

  parsed.hash = "";
  return parsed.toString();
}

const START_URL_REDIRECT_HOPS = 5;
const START_URL_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_USER_AGENT =
  "AriadneBot/0.1 (+https://github.com/dawnforge-lab/ariadne)";

export interface StartUrlRedirectOpts extends StartUrlOpts {
  userAgent?: string;
}

/**
 * Follow redirects on the audit's start URL so the audit anchors to the
 * site's real origin. Without this, auditing a domain that 301s elsewhere
 * (…net -> …com, apex -> www) dead-ends after one page: the redirect target
 * is a different origin, so the same-origin crawl policy can't follow it.
 *
 * Every hop re-runs the full start-URL validation (SSRF, blocked hosts), so
 * a redirect can't smuggle the audit somewhere the user couldn't have
 * pointed it directly. Probe failures (timeouts, HEAD rejected) fall back
 * to the last validated URL — the crawl records the real fetch result.
 *
 * Change from upstream: the input URL is validated before the first probe
 * rather than trusted, so this is safe to call on an unvalidated URL.
 */
export async function resolveStartUrlRedirects(
  startUrl: string,
  opts: StartUrlRedirectOpts = {},
): Promise<string> {
  const userAgent = opts.userAgent ?? DEFAULT_PROBE_USER_AGENT;
  let current = await normalizeAndValidateStartUrl(startUrl, opts);

  for (let hop = 0; hop < START_URL_REDIRECT_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(START_URL_PROBE_TIMEOUT_MS),
      });
    } catch {
      return current;
    }
    if (response.status < 300 || response.status >= 400) return current;
    const location = response.headers.get("location");
    if (!location) return current;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return current;
    }
    current = await normalizeAndValidateStartUrl(next.toString(), opts);
  }
  return current;
}

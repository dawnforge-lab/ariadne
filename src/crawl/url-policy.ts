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
 *  - 6to4 (2002::/16) and Teredo (2001::/32) evaluated on the IPv4 address
 *    they embed rather than waved through by that allowlist (build-plan §7,
 *    "before the first real-site crawl"). See embeddedIpv4s.
 *  - IPv4 literal parsing tightened to a strict dotted quad (upstream's
 *    Number() coercion read "10..0.1" as 10.0.0.1 and "0x7f.0.0.1" as
 *    127.0.0.1; WHATWG URL canonicalises those before we ever see them).
 *  - DoH resolution failures throw DNS_RESOLUTION_FAILED instead of being
 *    swallowed as "not blocked" (project rule: no silent fallbacks). The
 *    resolver's own text stays out of the message a caller sees
 *    (`resolveApprovedAddress`, "What the thrown message may say").
 *  - The DoH resolver is injectable so tests never touch the network.
 *  - resolveStartUrlRedirects validates its input before the first probe and
 *    sends Ariadne's user agent.
 *  - The test-only allowPrivate escape hatch has a floor it cannot lift:
 *    cloud metadata hosts and 169.254.0.0/16 stay refused.
 *  - Phase 26c: `isUrlAllowed` refuses a URL over `INDEXED_URL_MAX` with the
 *    reason `too_long`. Every column a URL is keyed by is btree-indexed, and
 *    Postgres refuses an entry that large, so such a URL can be neither queued
 *    nor recorded; refusing it here keeps it off every fetch path at once.
 */
import { fitsIndex, INDEXED_URL_MAX } from "./parse/url-utils.js";

/**
 * Hosts that are never crawlable, whatever they resolve to. Exported so the
 * `links.localhost` rule builds its SQL prefilter from this list rather than a
 * copy of it; `blockedHostReason` stays the authority on what is blocked.
 */
export const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

/** Exported for the same reason as `BLOCKED_HOSTS`. */
export const BLOCKED_HOST_SUFFIXES: readonly string[] = [
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

  /**
   * `message` is the sentence a caller of the API may be shown. `cause`, when
   * present, is the operator's detail behind it (a resolver's transport error,
   * a DoH HTTP status, a DNS rcode) and belongs in the server log only — see
   * `resolveApprovedAddress`.
   */
  constructor(code: UrlPolicyErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
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

/** An IPv4 address carried inside an IPv6 one, and what it is called there. */
interface EmbeddedIpv4 {
  /** Reads into a refusal: "6to4 IPv6 address (2002::/16) tunnelling to a …". */
  prefix: string;
  octets: number[];
}

/**
 * The IPv4 addresses a 6to4 or Teredo address carries inside it.
 *
 * Both live inside 2000::/3 and both are, in substance, an IPv4 destination
 * wearing an IPv6 spelling — so the global-unicast allowlist below waved them
 * straight through. `2002:7f00:1::1` is 127.0.0.1 and
 * `2001:0:4136:e378:8000:63bf:3f57:fefe` is 192.168.1.1, and neither was being
 * asked about. This is the same hole `::ffff:169.254.169.254` was, two RFCs
 * further along.
 *
 * **6to4 (RFC 3056 §2).** `2002:V4ADDR::/48` — the tunnel endpoint's IPv4
 * address is bits 16-47, in the clear. One address, no ambiguity.
 *
 * **Teredo (RFC 4380 §4).** `2001:0000::/32`, then four fields:
 *   bits 32-63   the Teredo SERVER's IPv4, in the clear
 *   bits 64-79   flags
 *   bits 80-95   the client's UDP port, obfuscated (XOR 0xFFFF)
 *   bits 96-127  the CLIENT's IPv4, obfuscated (XOR 0xFFFFFFFF)
 * The obfuscation is not a secret — §5.1.1 states it exists only to stop NATs
 * rewriting an address they recognise in a payload — so undoing it is reading,
 * not decryption.
 *
 * Our reading, stated because the RFC leaves the choice to the reader: the
 * CLIENT address (the obfuscated last 32 bits) is the meaningful endpoint —
 * it is the host the packets are ultimately for, and it is the field an SSRF
 * would put `192.168.0.1` in. The server address is not the client and must
 * not be mistaken for it. We check BOTH anyway, and name which one failed:
 * reaching a Teredo address means relaying through that server, so a server in
 * private space is a private destination too, and neither field has any
 * business pointing into RFC1918 on a crawl of the public web. Refusing the
 * pair costs us nothing real and refusing only one would leave half a hole.
 *
 * Returns an empty array for every other address, which is the overwhelming
 * majority — the two prefixes are matched exactly (`2002::/16`, `2001:0::/32`)
 * so ordinary global unicast such as 2001:4860:4860::8888 is untouched.
 */
function embeddedIpv4s(bytes: number[]): EmbeddedIpv4[] {
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return [
      {
        prefix: "6to4 IPv6 address (2002::/16) tunnelling to a",
        octets: bytes.slice(2, 6),
      },
    ];
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return [
      {
        prefix: "Teredo IPv6 address (2001::/32) whose client is a",
        // De-obfuscated: XOR 0xFFFFFFFF, RFC 4380 §4.
        octets: bytes.slice(12, 16).map((byte) => byte ^ 0xff),
      },
      {
        prefix: "Teredo IPv6 address (2001::/32) whose server is a",
        octets: bytes.slice(4, 8),
      },
    ];
  }
  return [];
}

/**
 * Allowlist rather than denylist: only 2000::/3 (global unicast) is crawlable.
 * That refuses ::1, ::, ::a.b.c.d, fc00::/7, fe80::/10, fec0::/10, ff00::/8
 * and 64:ff9b::/96 in every spelling, without enumerating them. IPv4-mapped
 * addresses defer to the IPv4 policy so ::ffff:127.0.0.1 is refused while a
 * mapped public address is not.
 *
 * The allowlist alone is not enough, though: 6to4 and Teredo addresses sit
 * inside 2000::/3 and carry an IPv4 destination in their own bits, so they
 * defer to the IPv4 policy too — see embeddedIpv4s. A 6to4 or Teredo address
 * whose embedded IPv4 is public is still crawlable; it is the embedding that
 * is checked, not the form.
 */
function ipv6Reason(bytes: number[]): string | null {
  const mapped = mappedIpv4(bytes);
  if (mapped !== null) {
    const reason = ipv4Reason(mapped);
    return reason === null ? null : `IPv4-mapped ${reason}`;
  }
  for (const embedded of embeddedIpv4s(bytes)) {
    const reason = ipv4Reason(embedded.octets);
    if (reason !== null) return `${embedded.prefix} ${reason}`;
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
  ).map((answer) => {
    const address = normalizeHost(answer.data);
    // An A/AAAA payload we cannot parse is a resolver anomaly, and the one
    // way a malformed answer could otherwise slip through: an unparseable
    // string is neither a blocked name nor a blocked literal, so the caller's
    // .some() would read it as "not blocked" and admit the host. Throw.
    if (parseIpv4(address) === null && parseIpv6(address) === null) {
      throw new UrlPolicyError(
        "DNS_RESOLUTION_FAILED",
        `DoH ${type} lookup for ${hostname} returned an unparseable address: ${answer.data}`,
      );
    }
    return address;
  });
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
 * Every IPv4 address a host denotes: a dotted quad, the IPv4 inside an
 * IPv4-mapped IPv6 literal, or the one(s) a 6to4 / Teredo address embeds. All
 * of those spellings must reach the same verdict — ::ffff:a9fe:a9fe,
 * 2002:a9fe:a9fe:: and 2001:0:4136:e378:8000:63bf:5601:5601 are all
 * 169.254.169.254 wearing a hat.
 */
function hostAsIpv4s(host: string): number[][] {
  const v4 = parseIpv4(host);
  if (v4 !== null) return [v4];
  const v6 = parseIpv6(host);
  if (v6 === null) return [];
  const mapped = mappedIpv4(v6);
  if (mapped !== null) return [mapped];
  return embeddedIpv4s(v6).map((embedded) => embedded.octets);
}

/**
 * The floor the test-only allowPrivate escape hatch cannot lift. If
 * allowPrivate ever leaks out of the test suite, the crawler still cannot
 * reach a cloud metadata service — the payload of almost every real SSRF.
 * Goes through hostAsIpv4s so no alternative spelling of 169.254.169.254 —
 * mapped, 6to4-tunnelled or Teredo-obfuscated — steps around the link-local
 * test. The hatch relaxes the policy; it does not relax the floor, and a
 * spelling the floor cannot read would be a hole in it.
 */
function hardBlockedReason(host: string): string | null {
  if (host !== "localhost" && BLOCKED_HOSTS.has(host)) {
    return `blocked host name (${host})`;
  }
  for (const v4 of hostAsIpv4s(host)) {
    if (v4[0] === 169 && v4[1] === 254) {
      return "link-local IPv4 address (169.254.0.0/16)";
    }
  }
  return null;
}

/**
 * The connect-time counterpart to isUrlAllowed, applied to an address the
 * resolver actually returned rather than to the URL as written. fetch-page
 * calls this from the socket `lookup` hook for every resolved address, which
 * is what closes the hole isUrlAllowed documents below (a public name with a
 * private A record) and the DNS-rebind window between any check and connect.
 *
 * It lives here, not in fetch-page, so the address policy has exactly one
 * definition: `allowPrivate` relaxes it to the same floor the facade uses.
 */
export function blockedAddressReason(
  address: string,
  opts: UrlPolicyOpts = {},
): string | null {
  const host = normalizeHost(address);
  if (!host) return "empty address";

  // Contract: this takes an *address*, so anything that is not a parseable IP
  // literal is a resolver anomaly and is refused, not admitted. Returning null
  // for a string we could not classify is precisely the silent fallback
  // resolveViaDoh already refuses to make.
  if (parseIpv4(host) === null && parseIpv6(host) === null) {
    return `unparseable resolved address (${address})`;
  }

  return opts.allowPrivate === true
    ? hardBlockedReason(host)
    : blockedHostReason(host);
}

/**
 * The seam every fetch path calls, on every URL, before every request —
 * discovered, redirected-to, or supplied by a client. Async by contract
 * (callers already await it).
 *
 * WHAT THIS CHECKS: the URL as written. Scheme, and whether the host is a
 * blocked name or an IP literal in blocked space. It is a string-level check.
 *
 * WHAT THIS DOES NOT CATCH — say it plainly, this is not complete SSRF
 * protection: a perfectly ordinary-looking hostname that *resolves* to a
 * private address (metadata.goog -> 169.254.169.254, or any attacker-owned
 * name with an A record in RFC1918) passes here. This function does no DNS,
 * deliberately: a DoH lookup per discovered link would make the crawl loop
 * unusable.
 *
 * WHERE THAT IS CLOSED: two other controls, neither of them here.
 *  1. The start URL (and every redirect hop it follows) is resolved and
 *     re-checked by normalizeAndValidateStartUrl / resolveStartUrlRedirects.
 *     That covers the operator-supplied entry point only.
 *  2. The fetch layer re-checks the address it actually connects to, at
 *     connect time — the only control that also closes the DNS-rebind window
 *     between any check and the socket. That is fetchPage's socket `lookup`
 *     hook calling blockedAddressReason (above); it is required, not
 *     optional, and this function cannot substitute for it.
 *
 * So: necessary, cheap, called on every URL — but the perimeter, not the wall.
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

  // Measured on the serialized URL, the ASCII form a row would hold. Not a
  // host question, so `allowPrivate` does not relax it.
  if (!fitsIndex(parsed.href)) {
    return {
      allowed: false,
      reason: `too_long (${parsed.href.length} characters; the limit is ${INDEXED_URL_MAX})`,
    };
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

export interface ApprovedAddressOpts extends UrlPolicyOpts {
  /** Injected in tests; defaults to the real DoH resolver. */
  resolve?: AddressResolver;
}

/**
 * The ONE address a host may be reached at, approved by this policy — for a
 * client that pins its resolution to it (the render pass's browser:
 * `--host-resolver-rules`), so nothing resolved later can point the host
 * somewhere else (DNS rebinding: a public answer at the check, a private one
 * at the connect).
 *
 * An IP literal is its own address, checked as one. A name is resolved (A and
 * AAAA) and refused if ANY answer is in blocked space — the same "mixed
 * answers are refused" rule as the start URL (`hostnameResolvesToBlockedAddress`)
 * — and refused if it has none. Of several approved answers the first IPv4 is
 * returned (else the first IPv6): a host with several A records is pinned to
 * one of them for the whole pass, which is a pin, not a load balancer, and the
 * caller says so. `allowPrivate` (TEST ONLY) relaxes the address check to the
 * same floor as everywhere else. A resolver failure throws (rule 7).
 *
 * ## What the thrown message may say
 *
 * The errors this function throws reach API callers verbatim (the render
 * pass's 409 and its `unpinnedHosts[].reason`), so their text is bounded here:
 *  - `CRAWL_TARGET_BLOCKED` names the host, the answer that was refused and
 *    the range it fell in. The answer is public DNS data about the caller's own
 *    site, and the same wording the crawl's own blocked-fetch rows carry
 *    (src/crawl/http.ts); a caller with a site that resolves into private
 *    space needs the address to see which record is wrong.
 *  - `DNS_RESOLUTION_FAILED` for a name with no record says so (`<host> has no
 *    A or AAAA record`): a fact about the site's DNS. For a RESOLVER failure
 *    it says only `<host> could not be resolved`, and the resolver's own
 *    message — the DoH transport error, its HTTP status, the DNS rcode, an
 *    unparseable answer — rides on `cause`, for the server log. That text
 *    describes our resolver path and whatever sat between it and Cloudflare,
 *    not the caller's site, and a tenant has no business reading it
 *    (docs/talos-integration.md, obligation 6).
 * A resolver that throws anything else is a defect, and passes through as one.
 */
export async function resolveApprovedAddress(
  hostname: string,
  opts: ApprovedAddressOpts = {},
): Promise<string> {
  const host = normalizeHost(hostname);
  if (!host) throw new UrlPolicyError("VALIDATION_ERROR", "empty host");
  const nameReason =
    opts.allowPrivate === true ? hardBlockedReason(host) : blockedHostReason(host);
  if (nameReason !== null) {
    throw new UrlPolicyError("CRAWL_TARGET_BLOCKED", `${host}: ${nameReason}`);
  }
  if (parseIpv4(host) !== null || parseIpv6(host) !== null) return host;

  const resolve = opts.resolve ?? resolveViaDoh;
  let v4: string[];
  let v6: string[];
  try {
    [v4, v6] = await Promise.all([resolve(host, "A"), resolve(host, "AAAA")]);
  } catch (cause) {
    if (cause instanceof UrlPolicyError && cause.code === "DNS_RESOLUTION_FAILED") {
      throw new UrlPolicyError("DNS_RESOLUTION_FAILED", `${host} could not be resolved`, {
        cause,
      });
    }
    throw cause;
  }
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) {
    throw new UrlPolicyError("DNS_RESOLUTION_FAILED", `${host} has no A or AAAA record`);
  }
  for (const address of addresses) {
    const reason = blockedAddressReason(address, opts);
    if (reason !== null) {
      throw new UrlPolicyError(
        "CRAWL_TARGET_BLOCKED",
        `${host} resolves into blocked address space (${address}: ${reason})`,
      );
    }
  }
  return v4[0] ?? addresses[0]!;
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

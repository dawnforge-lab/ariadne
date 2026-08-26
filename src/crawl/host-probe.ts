/**
 * The host-variant probe: what the site does when you ask for it by another of
 * its names.
 *
 * A site has four ordinary spellings — `http`/`https` × apex/`www` — and the
 * checklist asks three questions about them that no page-level crawl can
 * answer, because the crawl only ever fetches the one spelling it was seeded
 * with: does every variant end up on the canonical one (CHECK-13), does the
 * `http` spelling still serve a 200 instead of redirecting (CHECK-14), and
 * does a variant simply fail to resolve (CHECK-15). A legacy domain from a
 * rebrand is the same question asked of a fifth name, which is what
 * `legacyHosts` is for.
 *
 * Three properties this module exists to hold:
 *
 *  - **Every hop is a `fetchPage` call.** Redirects are followed by hand off
 *    `FetchResult.redirectUrl`, which fetch-page has already resolved and put
 *    through the URL policy (hard rule 5). Letting undici follow them would
 *    collapse the chain into one answer and lose the evidence; resolving the
 *    `Location` ourselves would launder an attacker-controlled string past the
 *    policy.
 *
 *  - **Nothing here throws for a site's behaviour.** A variant that does not
 *    resolve, a TLS handshake that fails, a `Location` the policy refused, a
 *    chain longer than the hop budget: each is recorded as the terminal hop of
 *    its variant, with the class fetch-page gave it. That IS the evidence
 *    (hard rule 7) — an exception here would lose the other three variants
 *    along with it. Our own bugs still throw: `fetchPage` rethrows a malformed
 *    user agent, and this module does not catch it.
 *
 *  - **The probe is cheap, finite and paced.** Four chains (plus legacy
 *    hosts), up to five hops each, origin roots only, run one at a time behind
 *    a `HostGate` at the crawl's own `perHostDelayMs` — keyed per hop's host,
 *    so a chain that walks apex -> www spaces each name separately and two
 *    chains through the same name still wait for each other. Without that gate
 *    the probe is the rudest thing the crawler does: twenty back-to-back
 *    requests at the start of every crawl (hard rule 9). robots.txt has not
 *    been read yet, so its `Crawl-delay` cannot be honoured here; the config
 *    delay is the floor that can be.
 */
import { isIP } from "node:net";
import { fetchPage, type FetchClass } from "./fetch-page.js";
import type { DnsLookupFn } from "./http.js";
import { HostGate } from "./politeness.js";

/**
 * Hops followed per variant. Five is the ceiling browsers and Googlebot both
 * work to; a chain longer than that is itself the finding, and is recorded as
 * one (`final: null` with five redirect hops).
 */
export const MAX_HOST_PROBE_HOPS = 5;

/** One request in a variant's chain, and what came back. */
export interface HostProbeHop {
  /** The URL this hop requested. */
  url: string;
  /** Null when nothing answered (DNS failure, TLS failure, timeout, refusal). */
  statusCode: number | null;
  fetchClass: FetchClass;
  /**
   * Where this hop was redirected to — absolute and already policy-checked by
   * fetch-page. Null when the hop was not a redirect, and also when it *was* a
   * redirect whose target the policy refused or which carried no `Location` at
   * all: the redirect is still recorded, only its target is not.
   */
  location: string | null;
}

export interface HostProbeVariant {
  /** The spelling this chain started from, always an origin root. */
  start: string;
  hops: HostProbeHop[];
  /**
   * The URL that answered with a non-redirect HTTP status — where this
   * spelling lands. Null when the chain never got such an answer: nothing
   * responded, a `Location` was dropped, or the hop budget ran out. A reader
   * that needs to know *why* reads the last hop.
   */
  final: string | null;
}

export interface HostProbeResult {
  variants: HostProbeVariant[];
}

export interface HostProbeOpts {
  userAgent: string;
  /**
   * Spacing between two requests to the same host, in ms — the crawl's own
   * `CrawlConfig.perHostDelayMs`. Required, not defaulted: a probe that paced
   * itself by a number nobody chose would be a politeness decision made by
   * omission (the same reason `CrawlConfig` has no defaults of its own).
   */
  perHostDelayMs: number;
  /** Per-hop deadline, passed straight to fetch-page. */
  timeoutMs?: number;
  /**
   * TEST ONLY, threaded to fetch-page (and through it to url-policy) so the
   * suite can probe a 127.0.0.1 fixture server. Never wire this to config, an
   * API field or an env var.
   */
  allowPrivate?: boolean;
  /** TEST ONLY, threaded to fetch-page. See FetchOpts.lookup. */
  lookup?: DnsLookupFn;
  /**
   * Hosts the site used to live on, from the operator or the client brief. A
   * bare host (`old.example`) is probed under both schemes; a full http(s) URL
   * is probed as written, at its origin root.
   */
  legacyHosts?: readonly string[];
}

/**
 * The apex/`www` spellings of a hostname, apex first, whichever way round the
 * input was written. Fixed order rather than "as seeded, then the twin" so the
 * stored evidence reads the same for a site seeded as `example.com` and one
 * seeded as `www.example.com`.
 *
 * An IP literal has no `www.` twin: `www.203.0.113.7` is not another name for
 * the same machine, it is a hostname that means nothing — and asking the
 * system resolver about it puts a made-up name on the wire (and, if some
 * wildcard DNS answers, a real address on the other end of a fetch). A site
 * addressed by IP gets its one spelling per scheme.
 */
function hostnameSpellings(hostname: string): string[] {
  // URL.hostname brackets IPv6 (`[::1]`), which net.isIP does not recognise.
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0) return [hostname];
  const apex = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  return [apex, `www.${apex}`];
}

/** The origin root of a URL, with the scheme swapped for `scheme`. */
function originRoot(url: URL, scheme: "http" | "https", hostname: string): string {
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${scheme}://${hostname}${port}/`;
}

/**
 * The exact list of URLs the probe will request first, in order: the site's
 * own spellings (four, or two when it is addressed by IP), then the legacy
 * hosts.
 *
 * Pure and exported because it is the probe's contract — the tests pin the
 * derivation here rather than inferring it from a network result, and the
 * crawl loop's evidence row is keyed by these strings.
 *
 * A `legacyHosts` entry that cannot be read as a host or an http(s) URL throws:
 * it is operator input naming a domain we are being asked to check, and
 * dropping it silently would report "the legacy domain is fine" about a domain
 * that was never probed (hard rule 7).
 */
export function hostProbeStarts(
  siteUrl: string,
  legacyHosts: readonly string[] = [],
): string[] {
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new Error(`hostProbeStarts: siteUrl is not a URL (${siteUrl})`);
  }
  if (site.protocol !== "http:" && site.protocol !== "https:") {
    throw new Error(`hostProbeStarts: siteUrl is not http(s) (${siteUrl})`);
  }

  const starts: string[] = [];
  const add = (url: string) => {
    if (!starts.includes(url)) starts.push(url);
  };

  for (const hostname of hostnameSpellings(site.hostname)) {
    for (const scheme of ["http", "https"] as const) {
      add(originRoot(site, scheme, hostname));
    }
  }

  for (const entry of legacyHosts) {
    const trimmed = entry.trim();
    if (trimmed.includes("://")) {
      let legacy: URL;
      try {
        legacy = new URL(trimmed);
      } catch {
        throw new Error(`hostProbeStarts: legacyHosts entry is not a URL (${entry})`);
      }
      if (legacy.protocol !== "http:" && legacy.protocol !== "https:") {
        throw new Error(
          `hostProbeStarts: legacyHosts entry is not http(s) (${entry})`,
        );
      }
      add(`${legacy.origin}/`);
      continue;
    }
    let bare: URL;
    try {
      bare = new URL(`https://${trimmed}`);
    } catch {
      throw new Error(`hostProbeStarts: legacyHosts entry is not a host (${entry})`);
    }
    // `new URL` accepts a surprising amount as a hostname; anything that came
    // back changed (a space, a path, credentials) was not a bare host.
    if (bare.hostname !== trimmed.toLowerCase() || bare.pathname !== "/") {
      throw new Error(`hostProbeStarts: legacyHosts entry is not a host (${entry})`);
    }
    for (const scheme of ["http", "https"] as const) {
      add(originRoot(bare, scheme, bare.hostname));
    }
  }

  return starts;
}

/** Follow one variant to wherever it lands, recording every hop. */
async function followChain(
  start: string,
  opts: HostProbeOpts,
  gate: HostGate,
): Promise<HostProbeVariant> {
  const hops: HostProbeHop[] = [];
  let url = start;

  for (let hop = 0; hop < MAX_HOST_PROBE_HOPS; hop += 1) {
    // Per hop, keyed by that hop's host: a chain that crosses from www to the
    // apex is two names, and each of them keeps its own spacing.
    await gate.acquire(new URL(url).host);
    const result = await fetchPage(url, {
      userAgent: opts.userAgent,
      allowPrivate: opts.allowPrivate,
      lookup: opts.lookup,
      timeoutMs: opts.timeoutMs,
    });
    hops.push({
      url,
      statusCode: result.statusCode,
      fetchClass: result.fetchClass,
      location: result.redirectUrl,
    });

    if (result.fetchClass !== "redirect") {
      // An answer, of some kind. It is a destination only if something on the
      // other end actually answered — a DNS or TLS failure lands nowhere.
      return { start, hops, final: result.statusCode === null ? null : url };
    }
    // A redirect whose target fetch-page dropped: the chain stops here, and the
    // hop already carries `location: null` and the reason it was dropped is
    // fetch-page's business, not the row's.
    if (result.redirectUrl === null) return { start, hops, final: null };
    url = result.redirectUrl;
  }

  // Budget spent with a redirect still pending: no landing place to name.
  return { start, hops, final: null };
}

/**
 * Probe every spelling of `siteUrl`'s host (plus any `legacyHosts`) and report
 * where each one lands.
 *
 * One chain at a time, and every hop through a `HostGate` at the crawl's
 * `perHostDelayMs`: these are the same machine under different names, and
 * twenty back-to-back requests to it would be the opposite of the politeness
 * the crawl proper is careful about (hard rule 9). It runs before discovery,
 * so robots.txt's own `Crawl-delay` is not known yet and cannot be honoured
 * here — the gate is built with `robotsCrawlDelaySec: null` and the crawl's
 * configured spacing is what it can promise.
 */
export async function probeHostVariants(
  siteUrl: string,
  opts: HostProbeOpts,
): Promise<HostProbeResult> {
  const gate = new HostGate({
    perHostDelayMs: opts.perHostDelayMs,
    robotsCrawlDelaySec: null,
  });
  const variants: HostProbeVariant[] = [];
  for (const start of hostProbeStarts(siteUrl, opts.legacyHosts ?? [])) {
    variants.push(await followChain(start, opts, gate));
  }
  return { variants };
}

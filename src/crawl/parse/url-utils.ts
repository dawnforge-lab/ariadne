/**
 * Adapted from open-seo (MIT), src/server/lib/audit/url-utils.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 * Changes: none to behaviour — the module was self-contained (no framework
 * imports) and every export is carried over verbatim. Added: this provenance
 * header, the doc comment on detectUrlTemplate's slug rule, and two
 * Ariadne-authored exports — `onRulesOrigin` (moved here from
 * src/crawl/discovery.ts) and `hostProbeStarts` with its two helpers (moved
 * here from src/crawl/host-probe.ts) — both so the rule layer can use them
 * without importing the fetch stack; see their own comments. The one import
 * below is a Node builtin, so the module stays free of framework and I/O
 * dependencies.
 */
import { isIP } from "node:net";

/**
 * **`normalizeUrl` is the single authority for frontier and dedupe keys.**
 * Two normalizers coexist in this codebase and they do not agree: url-policy's
 * start-URL normalization is *validation only* — it decides whether a URL may
 * be fetched at all — and its output is never a dedupe key. Anything that
 * identifies a page (frontier membership, `pages.url_normalised`, link target
 * matching) goes through this function and only this function. Task 9 passes
 * the seed URL through here before enqueue, so the seed and the links that
 * later point at it collapse to the same key.
 *
 * **This is not url-policy.** A URL this function returns is well-formed and
 * canonical, not permitted: it says nothing about private ranges, blocked
 * hosts or DNS. Every href it emits must still pass `isUrlAllowed` before the
 * crawler fetches it (hard rule 5) — discovered, redirected-to, or supplied by
 * a client.
 *
 * Normalize a URL for deduplication:
 * - Resolve relative URLs against a base
 * - Strip fragments (#...)
 * - Sort query parameters. Intentional canonicalization, not incidental:
 *   `?a=1&b=2` and `?b=2&a=1` are the same page on every stack that reads
 *   params by name, so sorting stops one page entering the frontier twice.
 *   It is also the clearest difference from url-policy's normalization, which
 *   leaves param order alone — one more reason that output is not a key.
 * - Lowercase the hostname
 * - Preserve trailing slashes. A trailing slash is the canonical form on most
 *   CMS platforms (WordPress etc.), which 301-redirect the non-slash version to
 *   it. Stripping it here would rewrite the canonical URL into its own redirect
 *   source, so the crawler would follow /path -> /path/ and strip back to /path
 *   forever — a 508 loop. Keeping /path and /path/ distinct lets the redirect
 *   resolve normally.
 */
export function normalizeUrl(url: string, base?: string): string | null {
  try {
    const parsed = new URL(url, base);

    // Only crawl HTTP(S)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    // Strip fragment
    parsed.hash = "";

    // Sort query params for consistent dedup
    parsed.searchParams.sort();

    // Lowercase hostname
    parsed.hostname = parsed.hostname.toLowerCase();

    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * A canonical key for URL equality checks that should survive the common
 * redirect patterns a site uses to reach its canonical form:
 *   - trailing-slash redirects   (/services -> /services/)
 *   - www <-> non-www            (www.example.com -> example.com)
 *   - http -> https upgrades
 *
 * Forces https, drops a leading "www.", lowercases the hostname, sorts query
 * params, and strips the fragment. Trailing slashes are intentionally left
 * intact so two genuinely different paths never collapse together; this key is
 * only for "is this effectively the same page as the start URL" comparisons,
 * not for crawl dedup.
 */
export function canonicalUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = "https:";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.toLowerCase();
  }
}

function getEffectivePort(parsed: URL): string {
  if (parsed.port) return parsed.port;
  return parsed.protocol === "https:" ? "443" : "80";
}

function areEquivalentHostnames(a: string, b: string): boolean {
  const hostA = a.toLowerCase();
  const hostB = b.toLowerCase();
  if (hostA === hostB) return true;
  return hostA === `www.${hostB}` || hostB === `www.${hostA}`;
}

/**
 * Check if a URL belongs to the same crawl boundary as the crawl target.
 *
 * Rules:
 * - Hostname must match, modulo a leading "www.".
 * - Same protocol/port is always allowed.
 * - http -> https upgrade on default ports is allowed.
 */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const parsedOrigin = new URL(origin);

    if (!areEquivalentHostnames(parsedUrl.hostname, parsedOrigin.hostname)) {
      return false;
    }

    const originProtocol = parsedOrigin.protocol.toLowerCase();
    const urlProtocol = parsedUrl.protocol.toLowerCase();

    const originPort = getEffectivePort(parsedOrigin);
    const urlPort = getEffectivePort(parsedUrl);

    if (originProtocol === urlProtocol) {
      return originPort === urlPort;
    }

    const isHttpToHttpsUpgrade =
      originProtocol === "http:" &&
      urlProtocol === "https:" &&
      originPort === "80" &&
      urlPort === "443";

    return isHttpToHttpsUpgrade;
  } catch {
    return false;
  }
}

/**
 * Rewrite a same-site URL onto the origin a robots.txt was read from, for the
 * purposes of a robots check only.
 *
 * robots-parser answers `undefined` for any URL whose origin differs from the
 * robots.txt it parsed, and `undefined` means "no rule forbids this" — so a
 * site that serves both `example.com` and `www.example.com` (or both schemes)
 * without redirecting would have every rule silently skipped for whichever
 * spelling a link or a sitemap `<loc>` happened to use, and `Disallow: /admin`
 * would not hold. `isSameOrigin` is the crawl boundary: URLs it admits are the
 * same site by our own rule, so the same path rules apply to them. It is
 * asymmetric about an http->https upgrade, so both directions are tried — the
 * rules origin can be the upgraded one when robots.txt redirected to https.
 *
 * The rewrite never leaves this function: the URL enqueued, fetched or reported
 * is the one the caller passed. A genuinely external URL is not rewritten and
 * keeps the old answer (no rules of ours apply to another site).
 *
 * Ariadne addition, not upstream. It lives here rather than in the crawler
 * because both the crawl-time robots check (src/crawl/discovery.ts) and the
 * rule that re-parses the stored robots.txt (src/rules/query/robots.ts) must
 * ask the question the same way, and the rule layer must not import the fetch
 * stack to do it.
 */
export function onRulesOrigin(url: string, rulesOrigin: string): string {
  if (!isSameOrigin(url, rulesOrigin) && !isSameOrigin(rulesOrigin, url)) return url;
  try {
    const parsed = new URL(url);
    const origin = new URL(rulesOrigin);
    parsed.protocol = origin.protocol;
    parsed.host = origin.host;
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Detect a URL template pattern by replacing path segments that look like
 * dynamic values (IDs, slugs, dates) with `:param`.
 *
 * Examples:
 *   /blog/my-great-post       → /blog/:slug
 *   /products/12345           → /products/:id
 *   /users/john-doe/settings  → /users/john-doe/settings  (see the slug rule)
 *
 * Slug rule: a segment is only treated as a slug when it has **three or more**
 * hyphen-separated parts. Two-part segments ("my-account", "john-doe",
 * "hello-world") are far more often fixed routes than content slugs, so they
 * stay literal. Downstream `page_type` derivation inherits that bias: a site
 * whose posts live at /blog/two-word-title gets one template per post rather
 * than a single /blog/:slug bucket.
 */
export function detectUrlTemplate(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);

  const normalized = segments.map((segment) => {
    // Pure numeric IDs
    if (/^\d+$/.test(segment)) return ":id";
    // UUIDs
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        segment,
      )
    )
      return ":uuid";
    // Date-like segments (2024-01-15)
    if (/^\d{4}-\d{2}-\d{2}$/.test(segment)) return ":date";
    // Slug-like: contains hyphens and is more than 2 segments (to avoid short
    // path parts like "my-account" that are likely fixed routes)
    if (segment.includes("-") && segment.split("-").length > 2) return ":slug";

    return segment;
  });

  return "/" + normalized.join("/");
}

/**
 * Extract the origin (protocol + hostname + port) from a URL string.
 */
export function getOrigin(url: string): string {
  return new URL(url).origin;
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
 * The exact list of URLs the host probe will request first, in order: the
 * site's own spellings (four, or two when it is addressed by IP), then the
 * legacy hosts.
 *
 * Pure and exported because it is the probe's contract — the tests pin the
 * derivation here rather than inferring it from a network result, the crawl
 * loop validates `legacyHosts` through it before the `crawls` row exists, and
 * the host rules subtract the crawl's own spellings from a stored probe with
 * it.
 *
 * Ariadne addition, not upstream, and it lives in this module for the reason
 * `onRulesOrigin` does: src/crawl/host-probe.ts is the fetch stack, and the
 * rule layer must be able to ask this question without importing it.
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

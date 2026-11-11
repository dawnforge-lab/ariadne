/**
 * A crawl's host footprint (Phase 28b, `crawls.host_key`): the seed's host,
 * lower-cased, without a leading `www.`, and — when the seed names a port that
 * is not its scheme's default — `:port` (Ruling R8): `127.0.0.1:41234`,
 * `[::1]:8080`; `https://x.com:443` is `x.com`.
 *
 * The frontier admits only the seed's host and its www/apex twin
 * (`isSameOrigin`, src/crawl/parse/url-utils.ts), so two crawls with one key
 * are two crawls of one site, and two crawls of one site at once would each
 * obey their own `HostGate` and together break hard rule 9. Claim eligibility
 * (`claimNextJob`, src/worker/jobs.ts) keeps one running crawl or render job
 * per key.
 *
 * The port is part of it because a host:port is what a politeness gate
 * spaces: two servers on two ports of one address are two sites (every test
 * fixture server is `127.0.0.1:<ephemeral>`), and keying them as one would
 * serialise unrelated work behind each other.
 *
 * Migration 0040 backfilled older rows with the port-less rule in SQL, and
 * 0042 appended the port to every row whose site URL names one; the two
 * together are pinned to this function by test/worker/jobs.test.ts.
 */
export function hostKeyOf(siteUrl: string): string {
  // `URL` lower-cases and punycodes the host, and leaves `port` empty for the
  // scheme's default port (named or not); an unparseable site URL throws, and
  // a crawl with no host has no footprint to guess.
  const url = new URL(siteUrl);
  if (url.hostname === "") throw new Error(`hostKeyOf: '${siteUrl}' has no host`);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return url.port === "" ? host : `${host}:${url.port}`;
}

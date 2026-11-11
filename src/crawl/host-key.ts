/**
 * A crawl's host footprint (Phase 28b, `crawls.host_key`): the seed's host,
 * lower-cased, without a leading `www.`.
 *
 * The frontier admits only the seed's host and its www/apex twin
 * (`isSameOrigin`, src/crawl/parse/url-utils.ts), so two crawls with one key
 * are two crawls of one site, and two crawls of one site at once would each
 * obey their own `HostGate` and together break hard rule 9. Claim eligibility
 * (src/worker/jobs.ts, Task 4) keeps one running per key. The port is not part
 * of it: a site is its host, whatever port serves it.
 *
 * Migration 0040 backfilled older rows with the same rule in SQL; the two are
 * pinned to each other by test/worker/jobs.test.ts.
 */
export function hostKeyOf(siteUrl: string): string {
  // `URL` lower-cases and punycodes the host; an unparseable site URL throws,
  // and a crawl with no host has no footprint to guess.
  const hostname = new URL(siteUrl).hostname;
  if (hostname === "") throw new Error(`hostKeyOf: '${siteUrl}' has no host`);
  return hostname.toLowerCase().replace(/^www\./, "");
}

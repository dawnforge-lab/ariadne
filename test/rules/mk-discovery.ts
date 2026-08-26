/**
 * The `crawls` row's evidence blobs for the rule tests, built to the shapes the
 * crawl loop actually writes (`DiscoveryEvidence` in src/crawl/loop.ts, and
 * `HostProbeResult` in src/crawl/host-probe.ts).
 *
 * The type annotation is the point: a test cannot describe a crawl row the
 * crawler could never have produced, and a change to the evidence shape breaks
 * these helpers at compile time rather than leaving the rule tests asserting
 * against a blob nothing writes any more.
 *
 * Defaults are the healthy site — robots.txt read whole, allow-all, one
 * declared sitemap, nothing truncated — so each test states only the fact it
 * is about.
 */
import type { DiscoveryEvidence } from "../../src/crawl/loop.js";
import type { DiscoveryTruncation } from "../../src/crawl/discovery.js";
import type { HostProbeResult } from "../../src/crawl/host-probe.js";
import { hostProbeStarts } from "../../src/crawl/parse/url-utils.js";

export function mkTruncation(
  overrides: Partial<DiscoveryTruncation> = {},
): DiscoveryTruncation {
  return {
    oversizedDocsSkipped: 0,
    docsFetched: 1,
    depthLimited: false,
    depthLimitedDocs: 0,
    docLimited: false,
    entryLimited: false,
    malformedEntriesSkipped: 0,
    failures: [],
    ...overrides,
  };
}

export function mkDiscovery(overrides: {
  robots?: Partial<DiscoveryEvidence["robots"]>;
  sitemapSources?: string[];
  truncation?: Partial<DiscoveryTruncation>;
  docsFetched?: number;
} = {}): DiscoveryEvidence {
  const truncation = mkTruncation(overrides.truncation);
  return {
    robots: {
      outcome: "read",
      crawlDelaySec: null,
      note: null,
      raw: "User-agent: *\nAllow: /\n",
      truncated: false,
      ...overrides.robots,
    },
    // Only the emptiness of this list is ever read (by `sitemap.missing`), so
    // the default is one declared source under a name no test asserts on.
    sitemapSources: overrides.sitemapSources ?? ["https://declared.example/sitemap.xml"],
    truncation,
    docsFetched: overrides.docsFetched ?? truncation.docsFetched,
  };
}

/**
 * `crawls.host_probe_jsonb` for a site whose host configuration is correct:
 * every spelling `hostProbeStarts` would probe redirects once into the
 * canonical https apex, which alone answers 200.
 *
 * Used by tests that are about something else and need the host rules to stay
 * quiet. A null column is NOT that: it means the probe never ran, which
 * `host.probe-skipped` reports — correctly, and on every crawl row that leaves
 * it out.
 */
export function mkHostProbe(siteUrl: string): HostProbeResult {
  const site = new URL(siteUrl);
  const port = site.port === "" ? "" : `:${site.port}`;
  const canonical = `https://${site.hostname.toLowerCase().replace(/^www\./, "")}${port}/`;
  return {
    variants: hostProbeStarts(siteUrl).map((start) =>
      start === canonical
        ? {
            start,
            hops: [{ url: start, statusCode: 200, fetchClass: "ok", location: null }],
            final: start,
          }
        : {
            start,
            hops: [
              { url: start, statusCode: 301, fetchClass: "redirect", location: canonical },
              { url: canonical, statusCode: 200, fetchClass: "ok", location: null },
            ],
            final: canonical,
          },
    ),
  };
}

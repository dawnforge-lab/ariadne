/**
 * `crawls.discovery_jsonb` for the rule tests, built to the shape the crawl
 * loop actually writes (`DiscoveryEvidence` in src/crawl/loop.ts).
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

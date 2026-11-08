/**
 * The streaming sitemap parser's memory bound, measured in a file of its own
 * (ruling R22).
 *
 * The assertion is an RSS DELTA, and RSS is a property of the process, not of
 * the parser: in test/crawl/sitemap-stream.test.ts the garbage the earlier
 * tests of that file left behind (their documents, a gzip bomb's members) could
 * be collected, or not, during this measurement, and once pushed the delta to
 * 85 MB. A file of its own runs in a fresh worker, so the baseline is this
 * test's alone. The assertion and its threshold are unchanged.
 */
import { describe, expect, it } from "vitest";
import { parseSitemapStream, SITEMAP_MAX_BYTES } from "../../src/crawl/sitemap-stream.js";

const MB = 1024 * 1024;
const encoder = new TextEncoder();

/**
 * A generated urlset, produced lazily: the 45 MB document is never a string
 * in this test either, so any RSS growth is the parser's.
 */
function entry(i: number): string {
  const id = String(i).padStart(10, "0");
  return (
    `<url><loc>https://www.example.com/p/${id}</loc><lastmod>2026-11-07</lastmod>` +
    `<xhtml:link rel="alternate" hreflang="de" href="https://www.example.com/de/p/${id}"/></url>\n`
  );
}
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
const TAIL = "</urlset>\n";
const ENTRY_BYTES = entry(0).length; // ASCII: characters are bytes

async function* generated(count: number): AsyncGenerator<Uint8Array> {
  const perChunk = Math.floor((64 * 1024) / ENTRY_BYTES);
  yield encoder.encode(HEAD);
  for (let at = 0; at < count; at += perChunk) {
    let text = "";
    for (let i = at; i < Math.min(at + perChunk, count); i++) text += entry(i);
    yield encoder.encode(text);
  }
  yield encoder.encode(TAIL);
}

describe("parseSitemapStream memory", () => {
  it(
    "streams a 45 MB urlset (about 270k entries) with RSS growth under 64 MB",
    async () => {
      const count = Math.floor((45 * MB - HEAD.length - TAIL.length) / ENTRY_BYTES);
      const total = HEAD.length + count * ENTRY_BYTES + TAIL.length;
      expect(total).toBeGreaterThan(44.9 * MB);
      expect(total).toBeLessThanOrEqual(45 * MB);

      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      let seen = 0;
      let lastLoc = "";
      let alternates = 0;
      const result = await parseSitemapStream(generated(count), {
        maxBytes: SITEMAP_MAX_BYTES,
        charset: null,
        onUrl: (e) => {
          seen++;
          lastLoc = e.loc;
          alternates += e.alternates.length;
          if (seen % 1000 === 0) peak = Math.max(peak, process.memoryUsage().rss);
        },
        onSitemap: () => undefined,
        onOverlongLoc: (entry) => {
          throw new Error(`unexpected over-long ${entry} loc`);
        },
        drain: async () => undefined,
      });
      peak = Math.max(peak, process.memoryUsage().rss);

      expect(result).toEqual({ kind: "urlset", bytes: total, oversized: false, malformedEntries: 0 });
      expect(seen).toBe(count);
      expect(alternates).toBe(count);
      expect(lastLoc).toBe(`https://www.example.com/p/${String(count - 1).padStart(10, "0")}`);
      expect(peak - baseline).toBeLessThan(64 * MB);
    },
    60_000,
  );
});

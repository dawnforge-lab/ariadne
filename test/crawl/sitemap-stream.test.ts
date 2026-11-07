import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  parseSitemapStream,
  SITEMAP_MAX_BYTES,
  type SitemapStreamResult,
  type SitemapUrlEntry,
} from "../../src/crawl/sitemap-stream.js";
import { MAX_HREFLANG_PAIRS } from "../../src/crawl/parse/page-analyzer.js";

const MB = 1024 * 1024;
const encoder = new TextEncoder();

/** A body split into `size`-byte chunks, so every token can straddle a boundary. */
async function* chunked(body: string | Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  for (let at = 0; at < bytes.byteLength; at += size) {
    yield bytes.subarray(at, Math.min(at + size, bytes.byteLength));
  }
}

interface Run {
  result: SitemapStreamResult;
  urls: SitemapUrlEntry[];
  sitemaps: { loc: string; lastmod: string | null }[];
  drains: number;
}

async function run(
  body: AsyncIterable<Uint8Array>,
  opts: { maxBytes?: number; charset?: string | null } = {},
): Promise<Run> {
  const urls: SitemapUrlEntry[] = [];
  const sitemaps: { loc: string; lastmod: string | null }[] = [];
  let drains = 0;
  const result = await parseSitemapStream(body, {
    maxBytes: opts.maxBytes ?? SITEMAP_MAX_BYTES,
    charset: opts.charset ?? null,
    onUrl: (entry) => urls.push(entry),
    onSitemap: (loc, lastmod) => sitemaps.push({ loc, lastmod }),
    drain: async () => {
      drains++;
    },
  });
  return { result, urls, sitemaps, drains };
}

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>https://site.example/en/</loc>
    <lastmod>2026-11-01</lastmod>
    <xhtml:link rel="alternate" hreflang="en" href="https://site.example/en/"/>
    <xhtml:link rel="alternate" hreflang="de" href="https://site.example/de/"/>
    <link rel="alternate" hreflang="x-default" href="https://site.example/"/>
    <xhtml:link rel="canonical" href="https://site.example/ignored"/>
    <xhtml:link rel="alternate" href="https://site.example/no-code"/>
  </url>
  <url>
    <loc>
      https://site.example/a?x=1&amp;y=2
    </loc>
  </url>
  <url><loc><![CDATA[https://site.example/cdata?p&q]]></loc><lastmod> 2026 </lastmod></url>
  <url><lastmod>2026-01-01</lastmod></url>
  <url><loc>   </loc></url>
  <url><loc>https://site.example/one</loc><loc>https://site.example/two</loc></url>
  <url><loc>https://site.example/x<b>y</b></loc></url>
  <URL><loc>https://site.example/upper-case-is-not-url</loc></URL>
</urlset>
`;

const URLSET_EXPECTED: SitemapUrlEntry[] = [
  {
    loc: "https://site.example/en/",
    lastmod: "2026-11-01",
    alternates: [
      { hreflang: "en", href: "https://site.example/en/" },
      { hreflang: "de", href: "https://site.example/de/" },
      { hreflang: "x-default", href: "https://site.example/" },
    ],
  },
  { loc: "https://site.example/a?x=1&y=2", lastmod: null, alternates: [] },
  { loc: "https://site.example/cdata?p&q", lastmod: "2026", alternates: [] },
];

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sm:sitemap><sm:loc>https://site.example/s1.xml</sm:loc><sm:lastmod>2026-10-01</sm:lastmod></sm:sitemap>
  <sm:sitemap><sm:loc>https://site.example/s2.xml.gz</sm:loc></sm:sitemap>
  <sm:sitemap><sm:lastmod>2026-10-02</sm:lastmod></sm:sitemap>
</sm:sitemapindex>`;

const INDEX_EXPECTED = [
  { loc: "https://site.example/s1.xml", lastmod: "2026-10-01" },
  { loc: "https://site.example/s2.xml.gz", lastmod: null },
];

describe("parseSitemapStream", () => {
  it("states the protocol's 50 MB uncompressed limit", () => {
    expect(SITEMAP_MAX_BYTES).toBe(50 * MB);
  });

  it("reads a urlset with alternates, whatever the chunking", async () => {
    for (const size of [1, 3, 7, 64, 1 << 20]) {
      const { result, urls, sitemaps } = await run(chunked(URLSET, size));
      expect(urls).toEqual(URLSET_EXPECTED);
      expect(sitemaps).toEqual([]);
      // No <loc>, a blank <loc>, two <loc>s, and a <loc> holding an element:
      // the four entries today's parser reads as having no usable loc.
      expect(result).toEqual({
        kind: "urlset",
        bytes: encoder.encode(URLSET).byteLength,
        oversized: false,
        malformedEntries: 4,
      });
    }
  });

  it("reads a sitemap index into onSitemap, never onUrl", async () => {
    const { result, urls, sitemaps } = await run(chunked(INDEX, 5));
    expect(sitemaps).toEqual(INDEX_EXPECTED);
    expect(urls).toEqual([]);
    expect(result).toEqual({
      kind: "index",
      bytes: encoder.encode(INDEX).byteLength,
      oversized: false,
      malformedEntries: 1,
    });
  });

  it("reads an empty urlset as a urlset with no entries", async () => {
    const { result, urls } = await run(
      chunked('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>', 8),
    );
    expect(urls).toEqual([]);
    expect(result).toMatchObject({ kind: "urlset", oversized: false, malformedEntries: 0 });
  });

  it("gives identical results for the document gzipped once and twice", async () => {
    for (const doc of [URLSET, INDEX]) {
      // Everything but the drain count, which follows the inflater's chunking.
      const outcome = ({ result, urls, sitemaps }: Run) => ({ result, urls, sitemaps });
      const plain = outcome(await run(chunked(doc, 13)));
      const once = outcome(await run(chunked(gzipSync(doc), 13)));
      const twice = outcome(await run(chunked(gzipSync(gzipSync(doc)), 13)));
      expect(plain.urls.length + plain.sitemaps.length).toBeGreaterThan(0);
      expect(once).toEqual(plain);
      expect(twice).toEqual(plain);
    }
  });

  it("stops after two gzip rounds, as today: a third layer is not a sitemap", async () => {
    const { result, urls } = await run(chunked(gzipSync(gzipSync(gzipSync(URLSET))), 64));
    expect(urls).toEqual([]);
    expect(result).toEqual({
      kind: "refused",
      reason: "no <urlset> or <sitemapindex> root element",
    });
  });

  it("throws a corrupt gzip body rather than reading it as empty", async () => {
    const gz = gzipSync(URLSET);
    const corrupt = Buffer.concat([gz.subarray(0, 12), Buffer.alloc(64, 0xff)]);
    await expect(run(chunked(corrupt, 16))).rejects.toThrow();
  });

  it("refuses a wrong root with today's reason, before any entry", async () => {
    const html = "<!-- an error page -->\n<html><body><urlset><url><loc>https://x.example/</loc></url></urlset></body></html>";
    const { result, urls } = await run(chunked(html, 4));
    expect(urls).toEqual([]);
    expect(result).toEqual({
      kind: "refused",
      reason: "no <urlset> or <sitemapindex> root element",
    });
  });

  it("refuses an empty body with the wrong-root reason", async () => {
    const { result } = await run(chunked("", 4));
    expect(result).toEqual({
      kind: "refused",
      reason: "no <urlset> or <sitemapindex> root element",
    });
  });

  it("refuses a DOCTYPE with today's reason, before any entry", async () => {
    const doc = `<?xml version="1.0"?>
<!doctype urlset [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>
<urlset><url><loc>https://site.example/&b;</loc></url></urlset>`;
    for (const size of [3, 1 << 20]) {
      const { result, urls } = await run(chunked(doc, size));
      expect(urls).toEqual([]);
      expect(result).toEqual({
        kind: "refused",
        reason: "refused: <!DOCTYPE declaration in a sitemap (entity-expansion risk)",
      });
    }
  });

  it("refuses a gzipped DOCTYPE the same way", async () => {
    const doc = '<!DOCTYPE urlset><urlset><url><loc>https://site.example/</loc></url></urlset>';
    const { result, urls } = await run(chunked(gzipSync(doc), 7));
    expect(urls).toEqual([]);
    expect(result).toMatchObject({ kind: "refused", reason: expect.stringMatching(/^refused: <!DOCTYPE declaration/) });
  });

  it("caps each entry's alternates at MAX_HREFLANG_PAIRS", async () => {
    const links = Array.from(
      { length: MAX_HREFLANG_PAIRS + 25 },
      (_, i) => `<xhtml:link rel="alternate" hreflang="l${i}" href="https://site.example/${i}"/>`,
    ).join("");
    const doc = `<urlset><url><loc>https://site.example/</loc>${links}</url><url><loc>https://site.example/b</loc><xhtml:link rel="alternate" hreflang="de" href="https://site.example/de/b"/></url></urlset>`;
    const { urls } = await run(chunked(doc, 100));
    expect(urls[0]?.alternates).toHaveLength(MAX_HREFLANG_PAIRS);
    expect(urls[0]?.alternates[MAX_HREFLANG_PAIRS - 1]).toEqual({
      hreflang: `l${MAX_HREFLANG_PAIRS - 1}`,
      href: `https://site.example/${MAX_HREFLANG_PAIRS - 1}`,
    });
    // The cap is per entry: the next <url> starts from zero.
    expect(urls[1]?.alternates).toEqual([{ hreflang: "de", href: "https://site.example/de/b" }]);
  });

  it("awaits drain after every chunk, before reading the next", async () => {
    const pulled: number[] = [];
    let drained = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      let i = 0;
      for await (const chunk of chunked(URLSET, 50)) {
        // Every chunk after the first is pulled only once the previous one drained.
        pulled.push(drained);
        expect(drained).toBe(i);
        i++;
        yield chunk;
      }
    }
    await parseSitemapStream(source(), {
      maxBytes: SITEMAP_MAX_BYTES,
      charset: null,
      onUrl: () => undefined,
      onSitemap: () => undefined,
      drain: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        drained++;
      },
    });
    expect(pulled.length).toBe(Math.ceil(encoder.encode(URLSET).byteLength / 50));
    expect(drained).toBeGreaterThanOrEqual(pulled.length);
  });

  it("decodes with the given charset, a multi-byte character split across chunks", async () => {
    const utf8 = "<urlset><url><loc>https://site.example/café</loc></url></urlset>";
    const { urls } = await run(chunked(utf8, 1), { charset: "utf-8" });
    expect(urls.map((u) => u.loc)).toEqual(["https://site.example/café"]);

    const latin1 = Buffer.from("<urlset><url><loc>https://site.example/café</loc></url></urlset>", "latin1");
    const { urls: latinUrls } = await run(chunked(latin1, 5), { charset: "windows-1252" });
    expect(latinUrls.map((u) => u.loc)).toEqual(["https://site.example/café"]);
  });

  it("refuses an unknown charset label rather than guessing one", async () => {
    const { result, urls } = await run(
      chunked("<urlset><url><loc>https://site.example/</loc></url></urlset>", 8),
      { charset: "x-not-a-charset" },
    );
    expect(result).toEqual({ kind: "refused", reason: 'refused: unknown charset label "x-not-a-charset"' });
    expect(urls).toEqual([]);
  });

  it("never emits an entry the end of the stream cut off, and counts it malformed", async () => {
    const cases = [
      // Cut inside a <loc>: the URL is half-written.
      "<urlset><url><loc>https://x.example/a</loc></url><url><loc>https://x.example/pro",
      // Cut after </loc> but before </url>: still not a finished entry.
      "<urlset><url><loc>https://x.example/a</loc></url><url><loc>https://x.example/b</loc>",
    ];
    for (const doc of cases) {
      for (const body of [chunked(doc, 5), chunked(gzipSync(doc), 5)]) {
        const { result, urls } = await run(body);
        expect(urls.map((u) => u.loc)).toEqual(["https://x.example/a"]);
        expect(result).toEqual({
          kind: "urlset",
          bytes: encoder.encode(doc).byteLength,
          oversized: false,
          malformedEntries: 1,
        });
      }
    }
    const index = "<sitemapindex><sitemap><loc>https://x.example/s1.xml</loc></sitemap><sitemap><loc>https://x.example/s2";
    const { result, sitemaps } = await run(chunked(index, 5));
    expect(sitemaps).toEqual([{ loc: "https://x.example/s1.xml", lastmod: null }]);
    expect(result).toMatchObject({ kind: "index", malformedEntries: 1 });
  });

  describe("owns the body and releases it on every exit", () => {
    /** A body whose generator records how much was pulled and whether it was closed. */
    function tracked(bytes: string | Uint8Array, size: number) {
      const state = { released: false, pulledChunks: 0, totalChunks: 0 };
      const all = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
      state.totalChunks = Math.ceil(all.byteLength / size);
      async function* source(): AsyncGenerator<Uint8Array> {
        try {
          for await (const chunk of chunked(all, size)) {
            state.pulledChunks++;
            yield chunk;
          }
        } finally {
          state.released = true;
        }
      }
      return { state, body: source() };
    }
    // Long enough that every early exit leaves most of the body unread, even
    // gzipped: random paths (144 KB of entropy) keep the gzip well past the
    // inflater pipeline's 64 KiB read-ahead, which would otherwise swallow it
    // whole. Kept small (~0.4 MB) so the memory tests below measure no leftovers.
    const ENTRIES = 6_000;
    const ENTRY_XML = Array.from(
      { length: ENTRIES },
      () => `<url><loc>https://site.example/${randomBytes(24).toString("base64url")}</loc></url>`,
    ).join("");
    const LONG = `<urlset>${ENTRY_XML}</urlset>`;
    const LONG_GZ = gzipSync(LONG);
    const WRONG_ROOT_GZ = gzipSync(`<html>${ENTRY_XML}</html>`);

    it("on an unknown-charset refusal", async () => {
      const { state, body } = tracked(LONG, 1024);
      const { result } = await run(body, { charset: "x-not-a-charset" });
      expect(result.kind).toBe("refused");
      expect(state.released).toBe(true);
      expect(state.pulledChunks).toBeLessThanOrEqual(1);
    });

    it("on a DOCTYPE refusal", async () => {
      const { state, body } = tracked(`<!DOCTYPE urlset>${LONG}`, 1024);
      const { result } = await run(body);
      expect(result).toMatchObject({ kind: "refused", reason: expect.stringMatching(/DOCTYPE/) });
      expect(state.released).toBe(true);
      expect(state.pulledChunks).toBeLessThan(state.totalChunks);
    });

    it("on a wrong-root refusal", async () => {
      const { state, body } = tracked(`<html>${LONG}</html>`, 1024);
      const { result } = await run(body);
      expect(result).toEqual({ kind: "refused", reason: "no <urlset> or <sitemapindex> root element" });
      expect(state.released).toBe(true);
      expect(state.pulledChunks).toBeLessThan(state.totalChunks);
    });

    it("at the cap, plain and gzipped", async () => {
      for (const bytes of [encoder.encode(LONG), LONG_GZ]) {
        const { state, body } = tracked(bytes, 1024);
        const { result } = await run(body, { maxBytes: 8 * 1024 });
        expect(result).toMatchObject({ kind: "urlset", oversized: true, bytes: 8 * 1024 });
        expect(state.released).toBe(true);
        expect(state.pulledChunks).toBeLessThan(state.totalChunks);
      }
    });

    it("on a wrong root inside a gzip", async () => {
      const { state, body } = tracked(WRONG_ROOT_GZ, 1024);
      const { result } = await run(body);
      expect(result.kind).toBe("refused");
      expect(state.released).toBe(true);
      expect(state.pulledChunks).toBeLessThan(state.totalChunks);
    });

    it("on normal completion", async () => {
      const { state, body } = tracked(LONG, 1024);
      const { result, urls } = await run(body);
      expect(result).toMatchObject({ kind: "urlset", oversized: false });
      expect(urls).toHaveLength(ENTRIES);
      expect(state.released).toBe(true);
      expect(state.pulledChunks).toBe(state.totalChunks);
    });
  });

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

  async function* generated(
    count: number,
    counter: { bytes: number } = { bytes: 0 },
  ): AsyncGenerator<Uint8Array> {
    const perChunk = Math.floor((64 * 1024) / ENTRY_BYTES);
    const head = encoder.encode(HEAD);
    counter.bytes += head.byteLength;
    yield head;
    for (let at = 0; at < count; at += perChunk) {
      let text = "";
      for (let i = at; i < Math.min(at + perChunk, count); i++) text += entry(i);
      const bytes = encoder.encode(text);
      counter.bytes += bytes.byteLength;
      yield bytes;
    }
    const tail = encoder.encode(TAIL);
    counter.bytes += tail.byteLength;
    yield tail;
  }

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

  it(
    "stops a 51 MB urlset at the 50 MB cap, keeping the entries read before it",
    async () => {
      const count = Math.ceil((51 * MB) / ENTRY_BYTES);
      const pulled = { bytes: 0 };
      let seen = 0;
      const result = await parseSitemapStream(generated(count, pulled), {
        maxBytes: SITEMAP_MAX_BYTES,
        charset: null,
        onUrl: () => {
          seen++;
        },
        onSitemap: () => undefined,
        drain: async () => undefined,
      });
      expect(result).toEqual({
        kind: "urlset",
        bytes: SITEMAP_MAX_BYTES,
        oversized: true,
        malformedEntries: 0,
      });
      // Every whole entry before the cap, and not the one it cut.
      const whole = Math.floor((SITEMAP_MAX_BYTES - HEAD.length) / ENTRY_BYTES);
      expect(seen).toBe(whole);
      // Reading stopped at the cap: the rest of the body was never pulled.
      expect(pulled.bytes).toBeLessThan(SITEMAP_MAX_BYTES + 128 * 1024);
    },
    60_000,
  );

  it("stops a gzip bomb at the decompressed cap without inflating the rest", async () => {
    // A multi-member gzip (RFC 1952 allows concatenated members, and gunzip
    // reads them as one stream): 1,000 members of 10,000 identical entries
    // each. About 7 MB on the wire, about 1.7 GB inflated — more than a V8
    // string can hold, so the document cannot have been held whole.
    const member = gzipSync(entry(0).repeat(10_000), { level: 9 });
    const members = 1_000;
    const bomb = Buffer.concat([
      gzipSync(HEAD),
      ...Array.from({ length: members }, () => member),
      gzipSync(TAIL),
    ]);
    const inflatedBytes = HEAD.length + members * 10_000 * ENTRY_BYTES + TAIL.length;
    expect(inflatedBytes).toBeGreaterThan(1_500 * MB);
    expect(bomb.byteLength).toBeLessThan(inflatedBytes / 200);

    const pulled = { bytes: 0 };
    async function* source(): AsyncGenerator<Uint8Array> {
      for await (const chunk of chunked(bomb, 1024)) {
        pulled.bytes += chunk.byteLength;
        yield chunk;
      }
    }
    let seen = 0;
    const cap = 4 * MB;
    const baseline = process.memoryUsage().rss;
    const result = await parseSitemapStream(source(), {
      maxBytes: cap,
      charset: null,
      onUrl: () => {
        seen++;
      },
      onSitemap: () => undefined,
      drain: async () => undefined,
    });
    const growth = process.memoryUsage().rss - baseline;

    expect(result).toEqual({ kind: "urlset", bytes: cap, oversized: true, malformedEntries: 0 });
    expect(seen).toBe(Math.floor((cap - HEAD.length) / ENTRY_BYTES));
    // Inflation stopped at the cap: only a small share of the bomb was read.
    expect(pulled.bytes).toBeLessThan(bomb.byteLength / 10);
    expect(growth).toBeLessThan(64 * MB);
  });
});

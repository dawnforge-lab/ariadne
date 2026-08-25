import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { discover } from "../../src/crawl/discovery.js";
import { closeFetchAgents } from "../../src/crawl/http.js";

/**
 * `maxCrawlDelayMs: 0` because the site fixture's robots.txt declares
 * `Crawl-delay: 5` and the walk now honours it — pacing is asserted in its own
 * test rather than paid for in every other one. `retryBackoffMs: 1` keeps the
 * robots retry path fast; the retry *count* is asserted, not its wall time.
 */
const OPTS = {
  userAgent: "AriadneBot-test",
  allowPrivate: true,
  maxCrawlDelayMs: 0,
  retryBackoffMs: 1,
};

/** The site with a robots.txt: the brief's fixture. */
let siteServer: Server;
let base: string;

/** A site with no robots.txt, carrying the recursion/gzip/cap fixtures. */
let bareServer: Server;
let bare: string;

/** A site whose robots.txt only ever 503s. */
let flakyServer: Server;
let flaky: string;
let flakyRobotsHits = 0;

/** A site that asks for a crawl-delay and serves three tiny sitemaps. */
let paceServer: Server;
let pace: string;

function xml(res: ServerResponse, body: string): void {
  res.setHeader("content-type", "application/xml");
  res.end(body);
}

function urlset(entries: { loc: string; lastmod?: string }[]): string {
  const items = entries
    .map(
      (e) =>
        `<url><loc>${e.loc}</loc>${
          e.lastmod === undefined ? "" : `<lastmod>${e.lastmod}</lastmod>`
        }</url>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</urlset>`;
}

function sitemapIndex(locs: string[]): string {
  const items = locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</sitemapindex>`;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  siteServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end(
        [
          "User-agent: *",
          "Disallow: /admin",
          "Crawl-delay: 5",
          `Sitemap: ${base}/sitemap.xml`,
          "",
        ].join("\n"),
      );
    } else if (path === "/sitemap.xml") {
      xml(
        res,
        sitemapIndex([`${base}/sitemap-1.xml`, `${base}/sitemap-oversized.xml`]),
      );
    } else if (path === "/sitemap-1.xml") {
      xml(
        res,
        urlset([
          { loc: `${base}/`, lastmod: "2026-08-01" },
          { loc: `${base}/shop` },
          { loc: `${base}/about` },
        ]),
      );
    } else if (path === "/sitemap-oversized.xml") {
      // 11MB of padding: over the 10MB per-document cap, skipped whole.
      res.setHeader("content-type", "application/xml");
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i < 11; i++) res.write(chunk);
      res.end();
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  base = await listen(siteServer);

  bareServer = createServer((req, res) => {
    const path = req.url ?? "";
    const deep = path.match(/^\/deep\/(\d)\.xml$/);
    const many = path.match(/^\/many\/(\d+)\.xml$/);

    if (path === "/gz/plain.xml.gz") {
      // A .gz file: gzip bytes with no content-encoding header.
      res.setHeader("content-type", "application/gzip");
      res.end(gzipSync(Buffer.from(urlset([{ loc: `${bare}/gz-a` }]))));
    } else if (path === "/gz/encoded.xml") {
      res.setHeader("content-type", "application/xml");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.from(urlset([{ loc: `${bare}/gz-b` }]))));
    } else if (path === "/gz/bomb.xml.gz") {
      // ~11KB on the wire, 11MB decompressed: the cap is on the decompressed
      // bytes, so this is skipped as oversized.
      res.setHeader("content-type", "application/gzip");
      res.end(gzipSync(Buffer.alloc(11 * 1024 * 1024, 0x61)));
    } else if (deep !== null) {
      const n = Number(deep[1]);
      if (n < 4) xml(res, sitemapIndex([`${bare}/deep/${n + 1}.xml`]));
      else xml(res, urlset([{ loc: `${bare}/too-deep` }]));
    } else if (path === "/loop-a.xml") {
      xml(res, sitemapIndex([`${bare}/loop-b.xml`]));
    } else if (path === "/loop-b.xml") {
      xml(res, sitemapIndex([`${bare}/loop-a.xml`, `${bare}/loop-urls.xml`]));
    } else if (path === "/loop-urls.xml") {
      xml(res, urlset([{ loc: `${bare}/looped` }]));
    } else if (path === "/many.xml") {
      const children: string[] = [];
      for (let i = 0; i < 350; i++) children.push(`${bare}/many/${i}.xml`);
      xml(res, sitemapIndex(children));
    } else if (many !== null) {
      xml(res, urlset([{ loc: `${bare}/many-page-${many[1]}` }]));
    } else if (path === "/bad.xml") {
      // The common real case: a server answering a sitemap request with an
      // HTML error page and a 200.
      res.setHeader("content-type", "text/html");
      res.end("<html><body><h1>Not found</h1></body></html>");
    } else if (path === "/empty-loc.xml") {
      xml(res, "<urlset><url><loc></loc></url></urlset>");
    } else if (path === "/hostile.xml") {
      xml(
        res,
        urlset([
          { loc: "javascript:alert(1)" },
          { loc: "not a url at all" },
          { loc: `${bare}/fine` },
        ]),
      );
    } else if (path === "/doctype.xml") {
      // A DTD inside the byte cap: a few hundred bytes that a parser expands
      // into gigabytes. Refused on the declaration, before parsing.
      xml(
        res,
        '<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY a "aaaaaaaaaa">' +
          '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
          '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>' +
          `<urlset><url><loc>${bare}/lol&c;</loc></url></urlset>`,
      );
    } else if (path === "/dupes.xml") {
      xml(res, urlset([{ loc: `${bare}/same`, lastmod: "2026-01-02" }]));
    } else if (path === "/dupes-2.xml") {
      xml(res, urlset([{ loc: `${bare}/same`, lastmod: "2026-07-07" }]));
    } else if (path === "/prefixed.xml") {
      res.setHeader("content-type", "application/xml");
      res.end(
        '<?xml version="1.0"?><sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          `<sm:url><sm:loc>${bare}/prefixed-page</sm:loc></sm:url></sm:urlset>`,
      );
    } else if (path === "/moved.xml") {
      res.statusCode = 301;
      res.setHeader("location", "/loop-urls.xml");
      res.end();
    } else if (path === "/moved-evil.xml") {
      res.statusCode = 301;
      res.setHeader("location", "file:///etc/passwd");
      res.end();
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  bare = await listen(bareServer);

  flakyServer = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      flakyRobotsHits++;
      res.statusCode = 503;
      res.end("down");
    } else if (req.url === "/s.xml") {
      xml(res, urlset([{ loc: `${flaky}/page` }]));
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  flaky = await listen(flakyServer);

  paceServer = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nCrawl-delay: 5\n");
    } else if (req.url === "/p1.xml") {
      xml(res, sitemapIndex([`${pace}/p2.xml`, `${pace}/p3.xml`]));
    } else {
      xml(res, urlset([{ loc: `${pace}${req.url ?? ""}-page` }]));
    }
  });
  pace = await listen(paceServer);
});

afterAll(async () => {
  await closeFetchAgents();
  for (const server of [siteServer, bareServer, flakyServer, paceServer]) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

describe("discover: robots.txt", () => {
  it("parses robots, crawl-delay and sitemap pointer", async () => {
    const d = await discover(base, OPTS);
    expect(d.robots.fetched).toBe(true);
    expect(d.robots.outcome).toBe("read");
    expect(d.robots.attempts).toBe(1);
    expect(d.robots.status).toBe(200);
    expect(d.robots.isAllowed(`${base}/admin/x`)).toBe(false);
    expect(d.robots.isAllowed(`${base}/shop`)).toBe(true);
    expect(d.robots.crawlDelaySec).toBe(5);
    expect(d.robots.sitemapUrls).toEqual([`${base}/sitemap.xml`]);
    expect(d.robots.raw).toContain("Disallow: /admin");
    expect(d.robots.note).toBeNull();
  });

  it("absent robots.txt (4xx) yields fetched=false and allow-all", async () => {
    const d = await discover(bare, { ...OPTS, userAgent: "x" });
    expect(d.robots.fetched).toBe(false);
    expect(d.robots.outcome).toBe("absent");
    expect(d.robots.isAllowed(`${bare}/anything`)).toBe(true);
    expect(d.robots.crawlDelaySec).toBeNull();
    expect(d.robots.sitemapUrls).toEqual([]);
    // A 4xx is definitive — the site said there are no rules. No retry.
    expect(d.robots.attempts).toBe(1);
    // Not an error, but not silent either: the reason is on the result.
    expect(d.robots.note).toContain("404");
  });

  it("retries a 5xx robots.txt, then disallows everything", async () => {
    flakyRobotsHits = 0;
    const d = await discover(flaky, OPTS);
    expect(d.robots.outcome).toBe("unreachable");
    expect(d.robots.status).toBe(503);
    expect(d.robots.attempts).toBe(3);
    expect(flakyRobotsHits).toBe(3);
    // RFC 9309 §2.3.1.4: unreachable is not permission.
    expect(d.robots.isAllowed(`${flaky}/`)).toBe(false);
    expect(d.robots.isAllowed(`${flaky}/anything`)).toBe(false);
    expect(d.robots.note).toContain("complete disallow");
    expect(d.robots.note).toContain("503");
  });

  it("does not walk sitemaps while a complete disallow is in force", async () => {
    const d = await discover(flaky, { ...OPTS, extraSitemaps: [`${flaky}/s.xml`] });
    expect(d.sitemapEntries).toEqual([]);
    expect(d.truncation.docsFetched).toBe(0);
    // Named, not silently absent.
    expect(d.truncation.failures[0]?.url).toBe(`${flaky}/s.xml`);
    expect(d.truncation.failures[0]?.reason).toContain("complete disallow");
  });

  it("onUnreachableRobots:allow crawls anyway, but never without pacing", async () => {
    const d = await discover(flaky, {
      ...OPTS,
      onUnreachableRobots: "allow",
      extraSitemaps: [`${flaky}/s.xml`],
    });
    expect(d.robots.outcome).toBe("unreachable");
    expect(d.robots.isAllowed(`${flaky}/anything`)).toBe(true);
    // The escape hatch is not free: an erroring origin still gets a delay.
    expect(d.robots.crawlDelaySec).toBe(5);
    expect(d.robots.note).toContain("caller's instruction");
    expect(d.sitemapEntries.map((e) => e.url)).toEqual([`${flaky}/page`]);
  });

  it("treats a network error as unreachable, with retries", async () => {
    // Port 1 on loopback: nothing listens there.
    const d = await discover("http://127.0.0.1:1/", OPTS);
    expect(d.robots.fetched).toBe(false);
    expect(d.robots.outcome).toBe("unreachable");
    expect(d.robots.attempts).toBe(3);
    expect(d.robots.isAllowed("http://127.0.0.1:1/x")).toBe(false);
    expect(d.robots.note).toContain("complete disallow");
  });

  it("refuses a site URL the policy blocks, without fetching or retrying", async () => {
    const d = await discover("http://169.254.169.254/", { ...OPTS, userAgent: "x" });
    expect(d.robots.fetched).toBe(false);
    expect(d.robots.outcome).toBe("unreachable");
    expect(d.robots.isAllowed("http://169.254.169.254/x")).toBe(false);
    // A refusal is deterministic: asking again would only be rude.
    expect(d.robots.attempts).toBe(1);
    expect(d.robots.note).toContain("169.254.169.254");
    expect(d.sitemapEntries).toEqual([]);
  });
});

describe("discover: politeness", () => {
  it("spaces sitemap fetches by the crawl-delay it just parsed", async () => {
    const started = Date.now();
    const d = await discover(pace, {
      ...OPTS,
      extraSitemaps: [`${pace}/p1.xml`],
      // The site asks for 5s; the ceiling brings that down to something a test
      // can wait for, exercising the same code path the governor will.
      maxCrawlDelayMs: 120,
    });
    const elapsed = Date.now() - started;

    expect(d.robots.crawlDelaySec).toBe(5);
    expect(d.truncation.docsFetched).toBe(3);
    // Gaps after robots.txt, p1 and p2 — three waits before the last fetch
    // returns. Loopback fetches themselves are sub-millisecond.
    expect(elapsed).toBeGreaterThanOrEqual(340);
    expect(elapsed).toBeLessThan(3_000);
    expect(d.sitemapEntries).toHaveLength(2);
  });

  it("is fast when pacing is off, so the delay above is the delay", async () => {
    const started = Date.now();
    await discover(pace, { ...OPTS, extraSitemaps: [`${pace}/p1.xml`] });
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe("discover: sitemaps", () => {
  it("recurses the sitemap index and records lastmod", async () => {
    const d = await discover(base, OPTS);
    expect(d.sitemapEntries.map((e) => e.url)).toHaveLength(3);
    expect(d.sitemapEntries.some((e) => e.lastmod !== null)).toBe(true);
    expect(d.sitemapEntries.every((e) => e.source === `${base}/sitemap-1.xml`)).toBe(
      true,
    );
  });

  it("skips oversized shards whole and counts them", async () => {
    const d = await discover(base, OPTS);
    expect(d.truncation.oversizedDocsSkipped).toBe(1);
    // index + shard + oversized shard: the oversized one was fetched, then
    // dropped — it is accounted for, not silently missing.
    expect(d.truncation.docsFetched).toBe(3);
  });

  it("reads gzip sitemaps, by extension and by content-encoding", async () => {
    const d = await discover(bare, {
      ...OPTS,
      extraSitemaps: [`${bare}/gz/plain.xml.gz`, `${bare}/gz/encoded.xml`],
    });
    expect(d.sitemapEntries.map((e) => e.url).sort()).toEqual([
      `${bare}/gz-a`,
      `${bare}/gz-b`,
    ]);
  });

  it("caps decompressed bytes, so a gzip bomb is an oversized skip", async () => {
    const d = await discover(bare, {
      ...OPTS,
      extraSitemaps: [`${bare}/gz/bomb.xml.gz`],
    });
    expect(d.truncation.oversizedDocsSkipped).toBe(1);
    expect(d.sitemapEntries).toEqual([]);
  });

  it("stops recursing below the depth cap", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/deep/0.xml`] });
    // Depths 0..3 are fetched; the index at depth 3 points one level too far.
    expect(d.truncation.docsFetched).toBe(4);
    expect(d.truncation.depthLimited).toBe(true);
    expect(d.truncation.depthLimitedDocs).toBe(1);
    expect(d.sitemapEntries).toEqual([]);
  });

  it("does not re-fetch a document a sitemap index cycle points back at", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/loop-a.xml`] });
    expect(d.truncation.docsFetched).toBe(3);
    expect(d.sitemapEntries.map((e) => e.url)).toEqual([`${bare}/looped`]);
  });

  it("caps the number of documents fetched", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/many.xml`] });
    expect(d.truncation.docsFetched).toBe(300);
    expect(d.truncation.docLimited).toBe(true);
    expect(d.sitemapEntries).toHaveLength(299);
  });

  it("caps the number of entries kept", async () => {
    const d = await discover(bare, {
      ...OPTS,
      extraSitemaps: [`${bare}/many.xml`],
      maxEntries: 10,
    });
    expect(d.sitemapEntries).toHaveLength(10);
    expect(d.truncation.entryLimited).toBe(true);
  });

  it("dedupes by url, first source wins", async () => {
    const d = await discover(bare, {
      ...OPTS,
      extraSitemaps: [`${bare}/dupes.xml`, `${bare}/dupes-2.xml`],
    });
    expect(d.sitemapEntries).toHaveLength(1);
    expect(d.sitemapEntries[0]?.source).toBe(`${bare}/dupes.xml`);
    expect(d.sitemapEntries[0]?.lastmod).toBe("2026-01-02");
  });

  it("reads namespace-prefixed sitemaps", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/prefixed.xml`] });
    expect(d.sitemapEntries.map((e) => e.url)).toEqual([`${bare}/prefixed-page`]);
  });

  it("drops entries that are not crawlable URLs, and counts them", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/hostile.xml`] });
    expect(d.sitemapEntries.map((e) => e.url)).toEqual([`${bare}/fine`]);
    expect(d.truncation.malformedEntriesSkipped).toBe(2);
  });

  it("records an unreachable sitemap instead of dropping it", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/gone.xml`] });
    expect(d.truncation.docsFetched).toBe(1);
    expect(d.truncation.failures).toHaveLength(1);
    expect(d.truncation.failures[0]?.url).toBe(`${bare}/gone.xml`);
    expect(d.truncation.failures[0]?.reason).toContain("404");
  });

  it("records a document that is not a sitemap instead of returning nothing quietly", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/bad.xml`] });
    expect(d.sitemapEntries).toEqual([]);
    expect(d.truncation.failures).toHaveLength(1);
    expect(d.truncation.failures[0]?.reason).toMatch(/urlset|sitemapindex/i);
  });

  it("refuses a sitemap carrying a DOCTYPE, before parsing it", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/doctype.xml`] });
    expect(d.sitemapEntries).toEqual([]);
    expect(d.truncation.failures).toHaveLength(1);
    expect(d.truncation.failures[0]?.reason).toContain("DOCTYPE");
  });

  it("skips an empty <loc> rather than emitting a blank url", async () => {
    const d = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/empty-loc.xml`] });
    expect(d.sitemapEntries).toEqual([]);
    expect(d.truncation.malformedEntriesSkipped).toBe(1);
  });

  it("puts every sitemap URL through the URL policy before fetching", async () => {
    const d = await discover(bare, {
      ...OPTS,
      extraSitemaps: ["file:///etc/passwd", "http://169.254.169.254/sitemap.xml"],
    });
    // Attempted, refused before a socket opened, and visible as failures —
    // docsFetched counts attempts so a hostile index cannot spend the budget
    // invisibly.
    expect(d.truncation.docsFetched).toBe(2);
    expect(d.truncation.failures).toHaveLength(2);
    expect(d.truncation.failures.map((f) => f.reason).join(" ")).toContain("scheme");
    expect(d.truncation.failures.map((f) => f.reason).join(" ")).toContain(
      "169.254.169.254",
    );
  });

  it("follows a sitemap redirect, but not to a refused target", async () => {
    const ok = await discover(bare, { ...OPTS, extraSitemaps: [`${bare}/moved.xml`] });
    expect(ok.sitemapEntries.map((e) => e.url)).toEqual([`${bare}/looped`]);

    const evil = await discover(bare, {
      ...OPTS,
      extraSitemaps: [`${bare}/moved-evil.xml`],
    });
    expect(evil.sitemapEntries).toEqual([]);
    expect(evil.truncation.failures[0]?.reason).toContain("scheme");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import {
  discover,
  ROBOTS_BLOCKED_REASON_PREFIX,
  robotsBlockedReason,
  robotsRulesOf,
  type SitemapSink,
} from "../../src/crawl/discovery.js";
import { closeFetchAgents } from "../../src/crawl/http.js";
import { INDEXED_URL_MAX } from "../../src/crawl/parse/url-utils.js";

/**
 * A sink that records what discovery hands it, in order. The crawl loop's sink
 * writes rows (test/crawl/loop.test.ts); what is under test here is what the
 * walk decides to hand over.
 */
interface RecordingSink extends SitemapSink {
  memberships: { url: string; source: string }[];
  alternates: { url: string; hreflang: string; href: string; source: string }[];
  flushes: number;
}

function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    memberships: [],
    alternates: [],
    flushes: 0,
    membership(url, source) {
      sink.memberships.push({ url, source });
    },
    alternate(url, a, source) {
      sink.alternates.push({ url, hreflang: a.hreflang, href: a.href, source });
    },
    async flush() {
      sink.flushes++;
    },
  };
  return sink;
}

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
  // Unpaced by default; the politeness block sets a real one.
  perHostDelayMs: 0,
  // Shared by the tests that do not look at it; the ones that do bring their own.
  sink: recordingSink(),
};

const NO_SITEMAP_FACTS = {
  memberships: 0,
  membershipLimited: false,
  hreflangRows: 0,
  hreflangLimited: false,
  overlongLocsSkipped: 0,
  oversizedDocs: [],
};

/** The 12 MB fixture: over the old 10 MB cap, well under the protocol's 50 MB. */
const BIG_ENTRIES = 11_000;
let bigSitemap: Buffer;

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
/** When each request reached the pace site, robots.txt included, in order. */
let paceHits: { path: string; at: number }[] = [];

/**
 * Two sites for the origin-variant matrix (build-plan §7, item 4), addressed
 * by NAME rather than by 127.0.0.1 so `www.` spellings are real hostnames.
 *
 *  - `apexRules`: serves its rules at the apex. Rules origin = the apex.
 *  - `wwwRules`:  301s /robots.txt to its own `www.` host, which is where the
 *    rules are actually served. Rules origin = the `www.` host. This is the
 *    commonest real shape (apex redirects to www) and the only way to get the
 *    www -> apex direction out of a socket we can bind.
 */
let apexRulesServer: Server;
let apexRules: string;
let apexRulesWww: string;
let apexRulesPort = 0;

let wwwRulesServer: Server;
let wwwRules: string;
let wwwRulesWww: string;

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

/**
 * Listen on every interface and address the site by name, so `localhost` and
 * `www.localhost` both reach it (`www.localhost` resolves to ::1 here). An IP
 * literal has no `www.` spelling, so the variant matrix needs a name.
 */
async function listenByName(server: Server): Promise<{ url: string; port: number }> {
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { url: `http://localhost:${port}`, port };
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
      xml(res, sitemapIndex([`${base}/sitemap-1.xml`]));
    } else if (path === "/sitemap-1.xml") {
      xml(
        res,
        urlset([
          { loc: `${base}/`, lastmod: "2026-08-01" },
          { loc: `${base}/shop` },
          { loc: `${base}/about` },
        ]),
      );
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
      // bytes, so this stops oversized at the (test-lowered) cap.
      res.setHeader("content-type", "application/gzip");
      res.end(
        gzipSync(
          Buffer.concat([
            Buffer.from(`<urlset><url><loc>${bare}/bomb-first</loc></url>`),
            Buffer.alloc(11 * 1024 * 1024, 0x20),
            Buffer.from("</urlset>"),
          ]),
        ),
      );
    } else if (path === "/gz/hollow.xml.gz") {
      // Thousands of empty gzip members: ~40KB on the wire that inflate to
      // almost nothing. The decompressed cap never trips; the wire cap does.
      const empty = gzipSync(Buffer.alloc(0));
      res.setHeader("content-type", "application/gzip");
      res.end(
        Buffer.concat([
          gzipSync(Buffer.from(`<urlset><url><loc>${bare}/hollow</loc></url>`)),
          ...Array.from({ length: 2_000 }, () => empty),
          gzipSync(Buffer.from("</urlset>")),
        ]),
      );
    } else if (path === "/big.xml") {
      res.setHeader("content-type", "application/xml");
      res.end(bigSitemap);
    } else if (path === "/cut.xml" || /^\/cuts\/\d+\.xml$/.test(path)) {
      xml(
        res,
        urlset(Array.from({ length: 2_000 }, (_, i) => ({ loc: `${bare}/cut/${i}` }))),
      );
    } else if (path === "/cuts.xml") {
      xml(res, sitemapIndex(Array.from({ length: 60 }, (_, i) => `${bare}/cuts/${i}.xml`)));
    } else if (path === "/twice.xml") {
      xml(res, urlset([{ loc: `${bare}/same` }, { loc: `${bare}/same` }]));
    } else if (path === "/alts.xml") {
      xml(
        res,
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
          'xmlns:xhtml="http://www.w3.org/1999/xhtml">' +
          `<url><loc>${bare}/en/a</loc>` +
          '<xhtml:link rel="alternate" hreflang="de" href="/de/a"/>' +
          `<xhtml:link rel="alternate" hreflang="en" href="${bare}/en/a"/>` +
          "</url></urlset>",
      );
    } else if (path === "/long.xml") {
      const longLoc = `${bare}/${"l".repeat(3_000)}`;
      xml(
        res,
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
          'xmlns:xhtml="http://www.w3.org/1999/xhtml">' +
          `<url><loc>${longLoc}</loc>` +
          '<xhtml:link rel="alternate" hreflang="de" href="/de/x"/></url>' +
          `<url><loc>${bare}/short</loc>` +
          `<xhtml:link rel="alternate" hreflang="de" href="/${"d".repeat(3_000)}"/>` +
          '<xhtml:link rel="alternate" hreflang="fr" href="/fr/short"/></url>' +
          "</urlset>",
      );
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
  const pad = "x".repeat(1_200);
  bigSitemap = Buffer.from(
    urlset(Array.from({ length: BIG_ENTRIES }, (_, i) => ({ loc: `${bare}/big/${i}/${pad}` }))),
  );

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
    paceHits.push({ path: req.url ?? "", at: Date.now() });
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

  apexRulesServer = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nDisallow: /admin\n");
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  const apexListen = await listenByName(apexRulesServer);
  apexRules = apexListen.url;
  apexRulesPort = apexListen.port;
  apexRulesWww = apexRules.replace("http://", "http://www.");

  wwwRulesServer = createServer((req, res) => {
    if (req.url !== "/robots.txt") {
      res.statusCode = 404;
      res.end("nope");
      return;
    }
    if (req.headers.host?.startsWith("www.") === true) {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nDisallow: /admin\n");
      return;
    }
    // Apex -> www, the shape most real sites have. Discovery follows redirects
    // on robots.txt, and the rules origin becomes wherever the bytes came from.
    res.statusCode = 301;
    res.setHeader("location", `${wwwRulesWww}/robots.txt`);
    res.end();
  });
  const wwwListen = await listenByName(wwwRulesServer);
  wwwRules = wwwListen.url;
  wwwRulesWww = wwwRules.replace("http://", "http://www.");
});

afterAll(async () => {
  await closeFetchAgents();
  for (const server of [
    siteServer,
    bareServer,
    flakyServer,
    paceServer,
    apexRulesServer,
    wwwRulesServer,
  ]) {
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

/**
 * Build-plan §7 "before the first real-site crawl", item 4: the www/apex
 * rewrite in `RobotsInfo.isAllowed` (`onRulesOrigin`).
 *
 * What the rewrite claims: a URL `isSameOrigin` admits into the crawl is
 * judged by the rules as if it were written on the origin robots.txt was read
 * from. Without it robots-parser answers `undefined` for the second spelling
 * of the same site — and `undefined` means "no rule forbids this", so
 * `Disallow: /admin` would silently stop applying to exactly the URLs the
 * crawler will go on to fetch (hard rule 9, and the worst kind of failure: a
 * false all-clear).
 *
 * There is one fixture test of this already (loop.test.ts, end to end through
 * a crawl). This is the matrix: both directions of the rewrite, and — as much
 * as it matters — the spellings it must NOT rewrite, because a rewrite that
 * caught too much would apply our site's rules to somebody else's URLs.
 *
 * Both halves run against real bytes off a real socket; the rules origin is
 * whatever the redirect chain settled on, exactly as in a crawl.
 *
 * NOT covered here, and deliberately: verification against a real www/apex
 * site on the open internet. That is the other half of build-plan §7 item 4
 * and it is recorded at the Phase 6 Task 7 gate, against the gate's real
 * target — a loopback fixture cannot prove that the shape we model is the
 * shape sites actually serve. The http -> https upgrade leg is in the same
 * position for a narrower reason: it is only ever taken on the default ports
 * (80 -> 443), which a test server cannot bind.
 */
describe("discover: robots origin-variant matrix", () => {
  it("applies apex rules to the www spelling, and only to it", async () => {
    const d = await discover(apexRules, OPTS);
    expect(d.robots.outcome).toBe("read");

    // The rules origin itself: the baseline the rest is measured against.
    expect(d.robots.isAllowed(`${apexRules}/admin/x`)).toBe(false);
    expect(d.robots.isAllowed(`${apexRules}/public`)).toBe(true);

    // apex -> www. The crawl admits this spelling (isSameOrigin), so it must
    // not escape the rules.
    expect(d.robots.isAllowed(`${apexRulesWww}/admin/x`)).toBe(false);
    // …and the rewrite judges, it does not blanket-refuse: an allowed path on
    // the variant is still allowed.
    expect(d.robots.isAllowed(`${apexRulesWww}/public`)).toBe(true);

    // A subdomain is a different site. `www.` is the one label the crawl
    // boundary treats as noise; `shop.` is not, so our rules do not travel
    // there and robots-parser's "no rule of mine applies" stands.
    expect(d.robots.isAllowed(`http://shop.localhost:${apexRulesPort}/admin/x`)).toBe(
      true,
    );
    expect(
      d.robots.isAllowed(`http://www.shop.localhost:${apexRulesPort}/admin/x`),
    ).toBe(true);

    // Another port is another origin — and one the crawl would not follow
    // either, so judging it under these rules would be a claim about a site we
    // never looked at.
    expect(d.robots.isAllowed(`http://localhost:${apexRulesPort + 1}/admin/x`)).toBe(
      true,
    );
    expect(d.robots.isAllowed(`http://www.localhost:${apexRulesPort + 1}/admin/x`)).toBe(
      true,
    );

    // Same host, same port, different scheme. This is NOT the http -> https
    // upgrade (that is defined on 80 -> 443 only), so it is a different origin
    // and stays unjudged — consistent with the crawl boundary, which will not
    // admit it either.
    expect(d.robots.isAllowed(`https://www.localhost:${apexRulesPort}/admin/x`)).toBe(
      true,
    );
  });

  it("applies www rules to the apex spelling when robots.txt redirected there", async () => {
    // /robots.txt 301s apex -> www, so the rules origin is the www host even
    // though the crawl was seeded at the apex. The rewrite has to run in this
    // direction too, and this is the direction real sites are in.
    const d = await discover(wwwRules, OPTS);
    expect(d.robots.outcome).toBe("read");

    expect(d.robots.isAllowed(`${wwwRulesWww}/admin/x`)).toBe(false);
    // www -> apex: the seed spelling, judged by the rules its own redirect
    // pointed at.
    expect(d.robots.isAllowed(`${wwwRules}/admin/x`)).toBe(false);
    expect(d.robots.isAllowed(`${wwwRules}/public`)).toBe(true);
    expect(d.robots.isAllowed(`${wwwRulesWww}/public`)).toBe(true);
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

  it("spaces sitemap fetches by the crawl's own delay when robots.txt asks for less", async () => {
    // The pace site asks for 5 s; a ceiling of 0 silences it, so the only
    // spacing left is the crawl's own. Before 24a this walk ran back-to-back.
    paceHits = [];
    const d = await discover(pace, {
      ...OPTS,
      extraSitemaps: [`${pace}/p1.xml`],
      maxCrawlDelayMs: 0,
      perHostDelayMs: 150,
    });
    expect(d.truncation.docsFetched).toBe(3);
    expect(paceHits.map((h) => h.path)).toEqual(["/robots.txt", "/p1.xml", "/p2.xml", "/p3.xml"]);
    // Measured at the site: every request starts at least the spacing after
    // the one before it (the gap is counted from the previous one's end).
    for (let i = 1; i < paceHits.length; i += 1) {
      const gap = (paceHits[i]?.at ?? 0) - (paceHits[i - 1]?.at ?? 0);
      expect(gap, `${paceHits[i]?.path}`).toBeGreaterThanOrEqual(150 - 5);
    }
  });

  it("refuses a perHostDelayMs it cannot pace by", async () => {
    await expect(discover(pace, { ...OPTS, perHostDelayMs: -1 })).rejects.toThrow(RangeError);
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

  // A supplied document is not a speculative one: somebody named it. What the
  // walk owes the origin is not fetching the same document twice because two
  // people named it in two spellings.
  it("walks a supplied document the site already declares exactly once", async () => {
    const declaredOnly = await discover(base, OPTS);
    // The same URL the robots.txt declares, in a spelling a person would paste
    // off a screen: same document, different string.
    const alsoSupplied = await discover(base, {
      ...OPTS,
      extraSitemaps: [`${base}/sitemap.xml#gid=0`],
    });

    expect(alsoSupplied.truncation.docsFetched).toBe(declaredOnly.truncation.docsFetched);
    expect(alsoSupplied.sitemapEntries.map((e) => e.url).sort()).toEqual(
      declaredOnly.sitemapEntries.map((e) => e.url).sort(),
    );
  });

  it("walks a supplied document robots.txt never declared", async () => {
    // `bare`'s robots.txt 404s, so it declares nothing: without the supplied
    // URL this walk reads no document at all, because the engine never guesses
    // at one nobody named.
    const d = await discover(bare, {
      ...OPTS,
      extraSitemaps: [`${bare}/gz/encoded.xml`],
    });
    expect(d.truncation.docsFetched).toBe(1);
    expect(d.sitemapEntries.length).toBeGreaterThan(0);
    // The entries carry the supplied document as their source, so a reader can
    // tell which document published a URL.
    expect(d.sitemapEntries.every((e) => e.source === `${bare}/gz/encoded.xml`)).toBe(true);
  });

  it("reads a 12 MB sitemap (over the old 10 MB cap) whole", async () => {
    expect(bigSitemap.byteLength).toBeGreaterThan(12 * 1024 * 1024);
    const sink = recordingSink();
    const d = await discover(bare, { ...OPTS, sink, extraSitemaps: [`${bare}/big.xml`] });
    expect(d.truncation.failures).toEqual([]);
    expect(d.truncation.oversizedDocsSkipped).toBe(0);
    expect(d.sitemapEntries).toHaveLength(BIG_ENTRIES);
    expect(sink.memberships).toHaveLength(BIG_ENTRIES);
    expect(d.sitemapFacts.memberships).toBe(BIG_ENTRIES);
    expect(d.sitemapFacts.oversizedDocs).toEqual([]);
  });

  it("stops a sitemap at the cap, keeps the URLs read before it, and names it oversized", async () => {
    const sink = recordingSink();
    const cap = 32 * 1024;
    const d = await discover(bare, {
      ...OPTS,
      sink,
      maxSitemapBytes: cap,
      extraSitemaps: [`${bare}/cut.xml`],
    });
    // Oversized is not a failure any more: `sitemap.oversized` reports it, not
    // `sitemap.invalid` (deviation 3).
    expect(d.truncation.failures).toEqual([]);
    expect(d.truncation.oversizedDocsSkipped).toBe(1);
    const kept = d.sitemapEntries.length;
    expect(kept).toBeGreaterThan(100);
    expect(kept).toBeLessThan(2_000);
    // The entries kept are the document's first ones, in order.
    expect(d.sitemapEntries[0]?.url).toBe(`${bare}/cut/0`);
    expect(d.sitemapEntries[kept - 1]?.url).toBe(`${bare}/cut/${kept - 1}`);
    expect(sink.memberships).toHaveLength(kept);
    expect(d.sitemapFacts.oversizedDocs).toEqual([
      { url: `${bare}/cut.xml`, bytesRead: cap, urlsKept: kept },
    ]);
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

  it("caps decompressed bytes, so a gzip bomb stops oversized at the cap", async () => {
    const cap = 1024 * 1024;
    const d = await discover(bare, {
      ...OPTS,
      maxSitemapBytes: cap,
      extraSitemaps: [`${bare}/gz/bomb.xml.gz`],
    });
    expect(d.truncation.oversizedDocsSkipped).toBe(1);
    expect(d.truncation.failures).toEqual([]);
    expect(d.sitemapEntries.map((e) => e.url)).toEqual([`${bare}/bomb-first`]);
    expect(d.sitemapFacts.oversizedDocs).toEqual([
      { url: `${bare}/gz/bomb.xml.gz`, bytesRead: cap, urlsKept: 1 },
    ]);
  });

  it("caps wire bytes too, so a gzip that inflates to nothing still stops", async () => {
    const cap = 8 * 1024;
    const d = await discover(bare, {
      ...OPTS,
      maxSitemapBytes: cap,
      extraSitemaps: [`${bare}/gz/hollow.xml.gz`],
    });
    expect(d.truncation.oversizedDocsSkipped).toBe(1);
    expect(d.truncation.failures).toEqual([]);
    expect(d.sitemapFacts.oversizedDocs).toHaveLength(1);
    expect(d.sitemapFacts.oversizedDocs[0]?.url).toBe(`${bare}/gz/hollow.xml.gz`);
    expect(d.sitemapFacts.oversizedDocs[0]?.bytesRead).toBeGreaterThan(cap);
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

/**
 * Phase 26c (Task 8): every `<loc>` a document lists is a membership, every
 * `xhtml:link` alternate is a staged hreflang row, and the walk's account of
 * both is `sitemapFacts`. The entry list (first source wins) is unchanged.
 */
describe("discover: memberships, alternates and sitemapFacts", () => {
  it("hands the sink one membership per document that lists a URL", async () => {
    const sink = recordingSink();
    const d = await discover(bare, {
      ...OPTS,
      sink,
      extraSitemaps: [`${bare}/dupes.xml`, `${bare}/dupes-2.xml`],
    });
    // One entry, first source wins — as before.
    expect(d.sitemapEntries.map((e) => [e.url, e.source])).toEqual([
      [`${bare}/same`, `${bare}/dupes.xml`],
    ]);
    // Two memberships: the URL is in both documents.
    expect(sink.memberships).toEqual([
      { url: `${bare}/same`, source: `${bare}/dupes.xml` },
      { url: `${bare}/same`, source: `${bare}/dupes-2.xml` },
    ]);
    expect(d.sitemapFacts.memberships).toBe(2);
    // Flushed while the walk ran, not only at its end.
    expect(sink.flushes).toBeGreaterThanOrEqual(2);
  });

  it("offers a URL one document lists twice twice; the table's key keeps one", async () => {
    const sink = recordingSink();
    const d = await discover(bare, { ...OPTS, sink, extraSitemaps: [`${bare}/twice.xml`] });
    expect(d.sitemapEntries).toHaveLength(1);
    expect(sink.memberships).toEqual([
      { url: `${bare}/same`, source: `${bare}/twice.xml` },
      { url: `${bare}/same`, source: `${bare}/twice.xml` },
    ]);
  });

  it("stages each alternate with its href resolved against the sitemap URL", async () => {
    const sink = recordingSink();
    const d = await discover(bare, { ...OPTS, sink, extraSitemaps: [`${bare}/alts.xml`] });
    expect(sink.alternates).toEqual([
      { url: `${bare}/en/a`, hreflang: "de", href: `${bare}/de/a`, source: `${bare}/alts.xml` },
      { url: `${bare}/en/a`, hreflang: "en", href: `${bare}/en/a`, source: `${bare}/alts.xml` },
    ]);
    expect(d.sitemapFacts.hreflangRows).toBe(2);
    expect(d.sitemapFacts.hreflangLimited).toBe(false);
  });

  it("counts a <loc> or alternate target over the index limit and hands neither over", async () => {
    const sink = recordingSink();
    const d = await discover(bare, { ...OPTS, sink, extraSitemaps: [`${bare}/long.xml`] });
    // The 3,000-character <loc> (and so its alternate) and the 3,000-character
    // alternate target on /short: two skips, counted once each.
    expect(d.sitemapFacts.overlongLocsSkipped).toBe(2);
    expect(d.sitemapEntries.map((e) => e.url)).toEqual([`${bare}/short`]);
    expect(sink.memberships.map((m) => m.url)).toEqual([`${bare}/short`]);
    expect(sink.alternates.map((a) => a.href)).toEqual([`${bare}/fr/short`]);
    for (const m of sink.memberships) expect(m.url.length).toBeLessThanOrEqual(INDEXED_URL_MAX);
    // Not a malformed entry: it is a URL, just one no index can hold.
    expect(d.truncation.malformedEntriesSkipped).toBe(0);
  });

  it("writes sitemapFacts with zeros when there is no sitemap", async () => {
    const d = await discover(bare, OPTS);
    expect(d.truncation.docsFetched).toBe(0);
    expect(d.sitemapFacts).toEqual(NO_SITEMAP_FACTS);
  });

  it("writes sitemapFacts with zeros when robots.txt is unreachable", async () => {
    const d = await discover(flaky, { ...OPTS, extraSitemaps: [`${flaky}/s.xml`] });
    expect(d.sitemapFacts).toEqual(NO_SITEMAP_FACTS);
  });

  it("counts every oversized document and names the first 50", async () => {
    const d = await discover(bare, {
      ...OPTS,
      maxSitemapBytes: 32 * 1024,
      extraSitemaps: [`${bare}/cuts.xml`],
    });
    // Sixty shards over the cap: every one counted, the first fifty named.
    expect(d.truncation.oversizedDocsSkipped).toBe(60);
    expect(d.sitemapFacts.oversizedDocs).toHaveLength(50);
    expect(d.sitemapFacts.oversizedDocs[0]?.url).toBe(`${bare}/cuts/0.xml`);
    expect(d.truncation.failures).toEqual([]);
  });
});

/**
 * `matchingRule` — the robots.txt line that DECIDED a URL (Phase 23 T3, study
 * D1). The crawl loop quotes it as the reason a robots-blocked row was never
 * requested, so it must name the line robots-parser actually applied, under
 * RFC 9309's precedence: longest pattern wins, Allow beats a Disallow of the
 * same length, `*` matches any run and a trailing `$` anchors the end.
 *
 * Pure: `robotsRulesOf` is the function `fetchRobots` builds `RobotsInfo`'s two
 * members from, so a text in and a verdict out is the whole of what is tested.
 */
describe("robotsRulesOf: the line that decided", () => {
  const SITE = "https://rules.example";
  const UA = "AriadneBot-test";
  const rulesFor = (raw: string) => robotsRulesOf(`${SITE}/robots.txt`, raw, UA);

  it("names the Disallow line that blocks a URL, comment stripped and trimmed", () => {
    const r = rulesFor(
      ["User-agent: *", "Disallow: /private/   # staff only", "Allow: /", ""].join("\n"),
    );
    expect(r.isAllowed(`${SITE}/private/x`)).toBe(false);
    expect(r.matchingRule(`${SITE}/private/x`)).toBe("Disallow: /private/");
    // The Allow line decides the rest of the site; it is still the deciding line.
    expect(r.isAllowed(`${SITE}/public`)).toBe(true);
    expect(r.matchingRule(`${SITE}/public`)).toBe("Allow: /");
  });

  it("lets the longest matching pattern win, whichever kind it is", () => {
    const r = rulesFor(
      ["User-agent: *", "Disallow: /shop/", "Allow: /shop/public/", "Disallow: /shop/public/drafts", ""].join(
        "\n",
      ),
    );
    expect(r.matchingRule(`${SITE}/shop/cart`)).toBe("Disallow: /shop/");
    expect(r.isAllowed(`${SITE}/shop/public/a`)).toBe(true);
    expect(r.matchingRule(`${SITE}/shop/public/a`)).toBe("Allow: /shop/public/");
    expect(r.isAllowed(`${SITE}/shop/public/drafts/1`)).toBe(false);
    expect(r.matchingRule(`${SITE}/shop/public/drafts/1`)).toBe("Disallow: /shop/public/drafts");
  });

  it("lets Allow win a tie of equal length", () => {
    const r = rulesFor(["User-agent: *", "Disallow: /page", "Allow: /page", ""].join("\n"));
    expect(r.isAllowed(`${SITE}/page`)).toBe(true);
    expect(r.matchingRule(`${SITE}/page`)).toBe("Allow: /page");
  });

  it("honours * and the $ anchor", () => {
    const r = rulesFor(
      ["User-agent: *", "Disallow: /*?filter=", "Disallow: /*.pdf$", ""].join("\r\n"),
    );
    expect(r.isAllowed(`${SITE}/shoes?filter=red`)).toBe(false);
    expect(r.matchingRule(`${SITE}/shoes?filter=red`)).toBe("Disallow: /*?filter=");
    expect(r.isAllowed(`${SITE}/files/a.pdf`)).toBe(false);
    expect(r.matchingRule(`${SITE}/files/a.pdf`)).toBe("Disallow: /*.pdf$");
    // `$` anchors: a PDF path with a query string after it is not matched.
    expect(r.isAllowed(`${SITE}/files/a.pdf?v=2`)).toBe(true);
    expect(r.matchingRule(`${SITE}/files/a.pdf?v=2`)).toBeNull();
  });

  it("is null where no line matched, and for another site's URL", () => {
    const r = rulesFor(["User-agent: *", "Disallow: /private/", ""].join("\n"));
    expect(r.matchingRule(`${SITE}/open`)).toBeNull();
    expect(r.isAllowed("https://other.example/private/x")).toBe(true);
    expect(r.matchingRule("https://other.example/private/x")).toBeNull();
  });

  it("judges the www spelling by the same lines", () => {
    const r = rulesFor(["User-agent: *", "Disallow: /private/", ""].join("\n"));
    expect(r.matchingRule("https://www.rules.example/private/x")).toBe("Disallow: /private/");
  });

  it("reads the group for the crawl's own user agent", () => {
    const r = rulesFor(
      ["User-agent: *", "Disallow: /", "", "User-agent: AriadneBot-test", "Disallow: /mine/", ""].join(
        "\n",
      ),
    );
    expect(r.isAllowed(`${SITE}/other`)).toBe(true);
    expect(r.matchingRule(`${SITE}/mine/x`)).toBe("Disallow: /mine/");
  });

  it("prefixes the stored reason so url-policy refusals stay distinguishable", () => {
    expect(ROBOTS_BLOCKED_REASON_PREFIX).toBe("robots.txt: ");
    expect(robotsBlockedReason("Disallow: /private/")).toBe("robots.txt: Disallow: /private/");
  });
});

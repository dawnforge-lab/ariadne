/**
 * The fixture site: a `node:http` server that serves the fixture collection
 * over real HTTP so the real crawler can crawl it.
 *
 * Six things this server owns beyond dispatch:
 *  - **The hub.** `/` links every fixture that asks to be linked, so one crawl
 *    from the seed reaches the collection at depth 1. A fixture with
 *    `linkedFromHub: false` is reachable only through the sitemap, which is what
 *    makes it an orphan (see `Fixture.linkedFromHub`); the deep click-path is
 *    the other opt-out, because the point of those pages is how far from the
 *    seed they are.
 *  - **robots.txt.** Allow all except `/private/`, and two `Sitemap:` lines.
 *    The disallowed prefix is not decoration: `/private/hidden` is listed in the
 *    sitemap and is therefore a URL the site publishes and its own robots.txt
 *    forbids, which is what `robots.blocks-sitemap-urls` reports and, since the
 *    crawl never enqueues it, what `sitemap.uncrawled` reports too.
 *  - **`/sitemap.xml`.** Every fixture that did not opt out, plus the hub, plus
 *    the one URL robots.txt blocks. Four of the entries are deliberately wrong
 *    in four different ways — a 404, a redirect, a noindexed page, and a URL
 *    that is never fetched — and one indexable page is deliberately left off.
 *    See `sitemapXml`.
 *  - **`/sitemap-broken.xml`**, the second declared document: a 200 that is not
 *    XML at all, which is the commonest broken sitemap in the wild and what
 *    `sitemap.invalid` reports.
 *  - **The static assets** the fixture pages reference (`/img/…`), served with
 *    real `content-type`, `content-length` and `cache-control` headers so the
 *    resource fetch pass has something true to record (see ./assets.ts).
 *  - **404 for everything else.**
 *
 * The listener binds every interface rather than 127.0.0.1 alone, so the site
 * answers to `localhost` as well as to the IP it is crawled by — that second
 * name is the `legacyHosts` entry the harness passes, and the only way
 * `host.legacy-host-reachable` can be exercised end to end (the `listenByName`
 * precedent in test/crawl/loop.test.ts). Crawling it needs `allowPrivate: true`,
 * which is the sanctioned test-only use of that flag (see CrawlConfig).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { assetHostImage, serveAsset } from "./assets.js";
import type { Fixture } from "./fixture.js";
import { escapeHtml, selfUrl } from "./render.js";

export interface FixtureApp {
  /** Origin, no trailing slash: `http://127.0.0.1:{port}`. */
  base: string;
  /**
   * The same server under a second name: `http://localhost:{port}`. Passed to
   * the crawl as a `legacyHosts` entry, where it plays the domain a rebranded
   * site used to live on and never redirected away.
   */
  legacyBase: string;
  close(): Promise<void>;
}

/**
 * The prefix robots.txt disallows. One fixture lives under it,
 * `/private/linked` (authored-p23.ts): the hub links it and the crawl must
 * record it unrequested (Phase 23 T3). Nothing else is served under it.
 */
const ROBOTS_BLOCKED_PREFIX = "/private/";
/**
 * The one sitemap entry that is not a fixture: a URL the site publishes and its
 * own robots.txt disallows, so the crawl never fetches it and no `pages` row
 * exists for it.
 */
const ROBOTS_BLOCKED_PATH = `${ROBOTS_BLOCKED_PREFIX}hidden`;

/** The second declared sitemap document: a 200 that is not a sitemap. */
const BROKEN_SITEMAP_PATH = "/sitemap-broken.xml";

/**
 * The hub is not a fixture and nothing is asserted about it, but it is still
 * crawled and judged, so it carries the head tags a healthy page carries — a
 * self-referential canonical included. Findings it does produce are ignored by
 * the harness, which counts coverage from fixture paths only.
 *
 * It also carries the fixture world's ONE third-party asset (P11-T2): an image
 * from the asset host, which is a different origin and therefore a second queue,
 * a second robots.txt and a second entry in the resource pass's host census. It
 * is on the hub rather than on a fixture page precisely because nothing is
 * asserted about the hub's own findings — and it carries `alt` and dimensions so
 * that the page rules stay as quiet about it as they were before it existed.
 */
function hubHtml(fixtures: readonly Fixture[], self: string): string {
  const links = fixtures
    .filter((f) => f.linkedFromHub !== false)
    .map((f) => `<li><a href="${escapeHtml(f.path)}">${escapeHtml(f.name)}</a></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ariadne fixture site</title>
<meta name="description" content="The hub page of the Ariadne fixture site: it links every fixture so one crawl from the seed reaches all of them.">
<link rel="canonical" href="${escapeHtml(self)}">
</head>
<body>
<main>
<h1>Ariadne fixture site</h1>
<img src="${escapeHtml(assetHostImage())}" alt="The Ariadne fixture site badge" width="720" height="360">
<p>Every page below is engineered to make the rule engine say something, except the control page, which is engineered to make it say nothing.</p>
<ul>
${links}
</ul>
</main>
</body>
</html>`;
}

/** The site's second name on a port: what `FixtureApp.legacyBase` is, one place. */
function legacyOriginOf(port: string | number): string {
  return `http://localhost:${port}`;
}

/**
 * The declared sitemap: the hub, every fixture that did not opt out, and the
 * robots-blocked URL.
 *
 * Entries are absolute (the protocol requires it, and `discover` refuses a
 * relative `<loc>` rather than guessing at one) and are written against the
 * Host header this request arrived on, for the same reason a fixture's canonical
 * is: the port is only known once the server is listening.
 *
 * A fixture may publish a spelling of its own URL that is not its request
 * target (`Fixture.sitemapLoc`): a fragment, or query parameters in an order
 * `normalizeUrl` would sort. That is what a real CMS emits, and the entry still
 * names the page the crawl fetched — see `/authored3/loc-variant`.
 *
 * `Fixture.sitemapLoc` may also start with `{legacy}`, which is replaced by the
 * site's second host name (`legacyOriginOf`) so an entry can name a host other
 * than the sitemap's own (`sitemap.cross-host-loc`); `Fixture.sitemapLastmod`
 * is written verbatim as the entry's `<lastmod>`, valid or not
 * (`sitemap.lastmod-invalid`).
 *
 * The order is the fixture order, which puts the hub first and keeps a diff of
 * this document readable. Nothing reads the order.
 */
function sitemapXml(fixtures: readonly Fixture[], origin: string): string {
  const legacyOrigin = legacyOriginOf(new URL(origin).port);
  const entries = [
    { loc: `${origin}/`, lastmod: undefined },
    ...fixtures
      .filter((f) => f.inSitemap !== false)
      .map((f) => {
        const target = f.sitemapLoc ?? f.path;
        return {
          loc: target.startsWith("{legacy}")
            ? `${legacyOrigin}${target.slice("{legacy}".length)}`
            : `${origin}${target}`,
          lastmod: f.sitemapLastmod,
        };
      }),
    { loc: `${origin}${ROBOTS_BLOCKED_PATH}`, lastmod: undefined },
  ]
    .map(
      (e) =>
        `  <url><loc>${escapeHtml(e.loc)}</loc>${
          e.lastmod === undefined ? "" : `<lastmod>${escapeHtml(e.lastmod)}</lastmod>`
        }</url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

/**
 * Start the fixture site. Duplicate fixture paths throw here rather than
 * shadowing each other silently — two fixtures on one path would make the
 * harness assert against a page that is not the one it thinks it is.
 */
export async function startFixtureApp(fixtures: readonly Fixture[]): Promise<FixtureApp> {
  const byPath = new Map<string, Fixture>();
  for (const fixture of fixtures) {
    if (!fixture.path.startsWith("/")) {
      throw new Error(`fixture path must start with "/": ${fixture.path}`);
    }
    if (byPath.has(fixture.path)) {
      throw new Error(`two fixtures claim the path ${fixture.path}`);
    }
    byPath.set(fixture.path, fixture);
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const target = req.url ?? "/";
    // A fixture may BE a query string (`/authored3/tracked?utm_source=…`), so
    // the whole request target is tried first. Falling back to the path alone is
    // what keeps a query from being part of a fixture's identity by accident:
    // the canonical-conflict page is asked for with `?via=…` and must still be
    // itself.
    const path = target.split("?")[0] ?? "/";

    if (path === "/") {
      send(res, 200, "text/html; charset=utf-8", hubHtml(fixtures, selfUrl(req)));
      return;
    }
    if (path === "/robots.txt") {
      const origin = new URL(selfUrl(req)).origin;
      send(
        res,
        200,
        "text/plain; charset=utf-8",
        [
          "User-agent: *",
          "Allow: /",
          `Disallow: ${ROBOTS_BLOCKED_PREFIX}`,
          `Sitemap: ${origin}/sitemap.xml`,
          `Sitemap: ${origin}${BROKEN_SITEMAP_PATH}`,
          "",
        ].join("\n"),
      );
      return;
    }
    if (path === "/sitemap.xml") {
      const origin = new URL(selfUrl(req)).origin;
      send(res, 200, "application/xml; charset=utf-8", sitemapXml(fixtures, origin));
      return;
    }
    if (path === BROKEN_SITEMAP_PATH) {
      // A 200 carrying an HTML error page, which is what a great many sites
      // serve for a sitemap path their CMS no longer handles. Its `<!doctype
      // html>` is what `discover` refuses on first — a DTD in a sitemap is an
      // entity-expansion risk and the document is dropped before the XML parser
      // sees it — so this fixture exercises that refusal rather than the
      // no-`<urlset>`-root branch behind it. Either way the document is a
      // declared sitemap that could not be read, which is `sitemap.invalid`.
      send(
        res,
        200,
        "text/html; charset=utf-8",
        "<!doctype html><title>Sitemap unavailable</title><h1>Sitemap unavailable</h1><p>This sitemap could not be generated.</p>",
      );
      return;
    }

    // The static assets the fixture pages reference, before the fixture lookup
    // (no fixture claims an `/img/` path) and after the site-level documents.
    if (serveAsset(req, res, path)) return;

    const fixture = byPath.get(target) ?? byPath.get(path);
    if (fixture === undefined) {
      send(res, 404, "text/html; charset=utf-8", "<!doctype html><title>404</title><p>No fixture here.</p>");
      return;
    }
    fixture.handler(req, res);
  });

  // Every interface, so the site answers to both of its names (see the header).
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${address.port}`,
    legacyBase: legacyOriginOf(address.port),
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    ),
  };
}

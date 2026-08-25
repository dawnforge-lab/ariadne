/**
 * The Phase 1 gate's synthetic site: a 50,000-page shop-and-blog served out of
 * a `node:http` handler that holds no state at all.
 *
 * Every byte of every response is a pure function of the request path. There is
 * no page table, no cache and no generation pass — the server can be killed and
 * restarted mid-crawl and serve byte-identical pages, which is precisely what
 * the crash-resume gate needs, and it means the fixture's own memory is O(1)
 * while the crawler's is the thing under test. If this file ever grows a `Map`
 * keyed by URL, the gate stops measuring the crawler and starts measuring the
 * fixture.
 *
 * The URL space is one contiguous index space, so "page id" and "URL" convert
 * both ways with no lookup:
 *
 *   index 0                          -> `/`
 *   index 1 .. products              -> `/products/p{n}`
 *   index products+1 .. pages-1      -> `/blog/{n}`
 *
 * Each page links to 20 others at `(index * 7 + k) % pages`, k = 1..20. Seven
 * is coprime with any page count that is not a multiple of it, so the map
 * `i -> 7i + k` is a bijection for each k: **every** index is some page's link
 * target, and the graph is strongly connected from `/` (the reachable set grows
 * by roughly a factor of seven per hop, so 50k pages are within six links of
 * the home page). The crawl therefore finds the whole site from the seed alone
 * — the sitemap shards are a second, independent path to the same 50,000 URLs,
 * not a crutch the link graph needs.
 *
 * Pages are ~15KB, which is a realistic mid-weight HTML document and, at 50k
 * pages, 750MB of HTML through a process that must stay under 512MB.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface GateSite {
  /** Origin, no trailing slash: `http://127.0.0.1:{port}`. */
  base: string;
  /** How many crawlable HTML URLs this site has, `/` included. */
  pages: number;
  close(): Promise<void>;
}

/** Internal links emitted per page. */
const LINKS_PER_PAGE = 20;

/** The stride behind the link graph. See the module header. */
const LINK_STRIDE = 7;

/** Sitemap shards under the index. */
const SITEMAP_SHARDS = 3;

/** Roughly one page's worth of body copy, in bytes. */
const FILLER_BYTES = 12_000;

/** One in this many product pages carries an image with no alt text. */
const MISSING_ALT_EVERY = 9;

/**
 * The word pool the body copy is sliced out of. A page takes a window into one
 * big pre-built string rather than assembling words per request: 50,000 pages
 * at ~2,000 words each is 100 million string operations if done naively, and a
 * fixture that spends more CPU than the crawler makes the pages/sec figure
 * meaningless.
 */
const WORDS = [
  "ariadne", "crawl", "frontier", "canonical", "sitemap", "robots", "index",
  "latency", "render", "schema", "product", "review", "catalogue", "variant",
  "shipping", "returns", "warranty", "material", "durable", "lightweight",
  "handmade", "workshop", "atelier", "provenance", "sourcing", "linen",
  "walnut", "brass", "ceramic", "indigo", "measurement", "dimensions",
  "assembly", "guarantee", "delivery", "stock", "restock", "seasonal",
  "collection", "archive", "journal", "essay", "interview", "studio",
  "process", "sketch", "prototype", "iteration", "finish", "patina",
];

/** ~64KB of deterministic prose, built once at module load. */
const FILLER_POOL = buildFillerPool();

function buildFillerPool(): string {
  const parts: string[] = [];
  // A Lehmer generator, so the pool is identical on every run and every machine
  // — a fixture whose bytes drift between runs makes two gate runs
  // incomparable.
  let state = 20_260_825;
  const target = FILLER_BYTES * 6;
  let length = 0;
  while (length < target) {
    state = (state * 48_271) % 2_147_483_647;
    const word = WORDS[state % WORDS.length] ?? "ariadne";
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(" ");
}

/** A page's body copy: a window into the pool, chosen by its index. */
function filler(index: number): string {
  const room = FILLER_POOL.length - FILLER_BYTES;
  const start = (index * 977) % room;
  return FILLER_POOL.slice(start, start + FILLER_BYTES);
}

export interface Layout {
  pages: number;
  /** `/products/p0` .. `/products/p{products-1}`. */
  products: number;
  /** `/blog/0` .. `/blog/{blog-1}`. */
  blog: number;
}

/**
 * Split `pages` into the home page, a product catalogue and a blog: one fifth
 * blog, the rest products, which is roughly the shape of the sites this engine
 * audits. The three counts always sum to `pages` exactly — the gate asserts on
 * a page count, so an off-by-one here would read as a crawler defect.
 */
function layout(pages: number): Layout {
  if (!Number.isInteger(pages) || pages < 3) {
    throw new RangeError(`startSiteServer: pages must be an integer ≥ 3, got ${pages}`);
  }
  const blog = Math.floor((pages - 1) / 5);
  return { pages, products: pages - 1 - blog, blog };
}

/** Index -> path. The inverse of `indexOfPath`. */
function pathOfIndex(index: number, site: Layout): string {
  if (index === 0) return "/";
  if (index <= site.products) return `/products/p${index - 1}`;
  return `/blog/${index - site.products - 1}`;
}

/**
 * Path -> index, or null when nothing lives there. Null is a 404, and the 404
 * matters: a fixture that answered every path with a page would hide a crawler
 * that invented URLs.
 */
function indexOfPath(path: string, site: Layout): number | null {
  if (path === "/") return 0;

  const product = /^\/products\/p(\d+)$/.exec(path);
  if (product !== null) {
    const n = Number(product[1]);
    return n < site.products ? n + 1 : null;
  }

  const blog = /^\/blog\/(\d+)$/.exec(path);
  if (blog !== null) {
    const n = Number(blog[1]);
    return n < site.blog ? site.products + 1 + n : null;
  }

  return null;
}

/** The 20 indices this page links to. */
function linkTargets(index: number, site: Layout): number[] {
  const targets: number[] = [];
  for (let k = 1; k <= LINKS_PER_PAGE; k++) {
    targets.push((index * LINK_STRIDE + k) % site.pages);
  }
  return targets;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageTitle(index: number, site: Layout): string {
  if (index === 0) return "Ariadne Gate Fixture — Home";
  if (index <= site.products) return `Product ${index - 1} — Ariadne Gate Fixture`;
  return `Journal ${index - site.products - 1} — Ariadne Gate Fixture`;
}

/**
 * One page, ~15KB. Product pages carry a JSON-LD `Product` block; every page
 * carries a canonical, two hreflang alternates, a heading tree, four images
 * (one of them alt-less on some products, so the analyzer's
 * `images_missing_alt` is not uniformly zero) and 20 internal links.
 */
function renderPage(index: number, site: Layout, base: string): string {
  const path = pathOfIndex(index, site);
  const isProduct = index >= 1 && index <= site.products;
  const title = pageTitle(index, site);
  const description =
    `Deterministic gate fixture page ${index} of ${site.pages}. ` +
    `Synthetic ${isProduct ? "product" : "editorial"} copy for the Ariadne 50k crawl gate.`;

  const links = linkTargets(index, site)
    .map((target) => {
      const href = pathOfIndex(target, site);
      return `<li><a href="${href}">${escapeHtml(pageTitle(target, site))}</a></li>`;
    })
    .join("\n");

  const jsonLd = isProduct
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: title,
        sku: `SKU-${index - 1}`,
        description,
        url: `${base}${path}`,
        offers: {
          "@type": "Offer",
          priceCurrency: "EUR",
          price: (((index * 37) % 90_000) / 100).toFixed(2),
          availability: "https://schema.org/InStock",
        },
      })}</script>`
    : "";

  const images = [0, 1, 2, 3]
    .map((n) => {
      const src = `/media/${index}-${n}.jpg`;
      const altless = isProduct && n === 3 && index % MISSING_ALT_EVERY === 0;
      return altless
        ? `<img src="${src}" width="640" height="480">`
        : `<img src="${src}" alt="${escapeHtml(title)} view ${n}" width="640" height="480">`;
    })
    .join("\n");

  const body = filler(index);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${base}${path}">
<link rel="alternate" hreflang="en" href="${base}${path}">
<link rel="alternate" hreflang="fr" href="${base}/fr${path === "/" ? "/" : path}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${base}/media/${index}-0.jpg">
${jsonLd}
</head>
<body>
<header><nav><a href="/">Home</a> <a href="/products/p0">Catalogue</a> <a href="/blog/0">Journal</a></nav></header>
<main>
<h1>${escapeHtml(title)}</h1>
<h2>Overview</h2>
<p>${escapeHtml(description)}</p>
${images}
<h2>Detail</h2>
<p>${body}</p>
<h3>Related</h3>
<ul>
${links}
</ul>
</main>
<footer><p>Ariadne gate fixture — page ${index} of ${site.pages}.</p></footer>
</body>
</html>
`;
}

function robotsTxt(base: string): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Crawl-delay: 0",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

function sitemapIndex(base: string): string {
  const shards = Array.from(
    { length: SITEMAP_SHARDS },
    (_, shard) => `<sitemap><loc>${base}/sitemap-${shard}.xml</loc></sitemap>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${shards}
</sitemapindex>
`;
}

/**
 * One shard. The shards partition the whole index space, so the three of them
 * together declare all `pages` URLs — the sitemap is a complete second route to
 * every page, which is what makes it a real test of the discovery path rather
 * than decoration.
 */
function sitemapShard(shard: number, site: Layout, base: string): string {
  const per = Math.ceil(site.pages / SITEMAP_SHARDS);
  const start = shard * per;
  const end = Math.min(start + per, site.pages);
  const urls: string[] = [];
  for (let index = start; index < end; index++) {
    urls.push(`<url><loc>${base}${pathOfIndex(index, site)}</loc><lastmod>2026-08-25</lastmod></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  const buffer = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": buffer.byteLength,
  });
  res.end(buffer);
}

/** The whole site as one pure function: a path in, a response out. */
function respond(path: string, site: Layout, base: string, res: ServerResponse): void {
  if (path === "/robots.txt") {
    send(res, 200, "text/plain; charset=utf-8", robotsTxt(base));
    return;
  }
  if (path === "/sitemap.xml") {
    send(res, 200, "application/xml; charset=utf-8", sitemapIndex(base));
    return;
  }
  const shard = /^\/sitemap-(\d+)\.xml$/.exec(path);
  if (shard !== null) {
    const n = Number(shard[1]);
    if (n < SITEMAP_SHARDS) {
      send(res, 200, "application/xml; charset=utf-8", sitemapShard(n, site, base));
      return;
    }
  }

  const index = indexOfPath(path, site);
  if (index === null) {
    send(res, 404, "text/html; charset=utf-8", "<!doctype html><title>404</title><h1>Not found</h1>");
    return;
  }
  send(res, 200, "text/html; charset=utf-8", renderPage(index, site, base));
}

/**
 * The pure core, exported for the smoke test: the HTML a path serves (null
 * where the site 404s), the index space, and the two documents the crawl reads
 * before any page. Everything the server does goes through these, so a test
 * that exercises them needs no socket.
 */
export const siteFixture = {
  layout,
  pathOfIndex,
  indexOfPath,
  linkTargets,
  sitemapShards: SITEMAP_SHARDS,
  page(path: string, site: Layout, base: string): string | null {
    const index = indexOfPath(path, site);
    return index === null ? null : renderPage(index, site, base);
  },
  robotsTxt,
  sitemapIndex,
  sitemapShard,
};

/**
 * Start the fixture on an ephemeral loopback port.
 *
 * The listener binds 127.0.0.1 explicitly: the crawler will only be pointed at
 * this with `allowPrivate: true`, and a fixture that also answered on a routable
 * interface would be a fixture other people can reach.
 */
export async function startSiteServer(pages: number): Promise<GateSite> {
  const site = layout(pages);
  let base = "";

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Query strings and fragments are not part of this site's URL space; the
    // path alone decides the response, which is the determinism promise.
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    respond(path, site, base, res);
  });

  // The crawler holds 16 sockets open across a run of several minutes; the
  // default 5s keep-alive would churn connections for no reason.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    pages,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

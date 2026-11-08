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
 *
 * SITEMAP HREFLANG (Phase 26c gate, `GATE_SITEMAP_HREFLANG=1`). Off by default,
 * and off means every byte this server sends is what it sent before the switch
 * existed, so a run without it compares like for like with the baseline. On,
 * the sitemap shards — and nothing else — carry `xhtml:link` alternates on
 * every `<url>`, so the sitemap stream, the `sitemap_hreflang` staging, the
 * derivation into `hreflang` and the hreflang rules (`hreflang.invalid-code`
 * among them) run at 50k scale. The shape:
 *
 *  - the index space is cut into LOCALE CLUSTERS of `LOCALE_CLUSTER` (11)
 *    consecutive pages; the last, short cluster (fewer than 11 left over) joins
 *    the one before it, so a cluster has 11 to 21 members (a site of fewer than
 *    11 pages is one cluster of all of them);
 *  - every member lists every member of its cluster, itself included, each
 *    under its own code from `HREFLANG_LOCALES` (member k gets code k: `de-DE`,
 *    `de-AT`, …), plus `x-default` pointing at the cluster's first member. So
 *    each URL states 11 to 21 locales and `x-default`, every target is a page
 *    this server serves (and the crawl fetches), and every cluster is fully
 *    reciprocal, as a correct site's is;
 *  - the codes are valid BCP 47 language-region pairs and never `en` or `fr`,
 *    the two codes the page HTML states (`en` self, `fr` to a `/fr/…` URL that
 *    404s). The sources therefore never disagree on one code's target, so the
 *    switch adds no `hreflang.source-conflict` (deviation 4: a code one source
 *    lists and the other omits is not a conflict).
 *
 * At 50,000 pages that is about 600,000 alternates, ~19 MB per shard: under the
 * protocol's 50 MB, and under `MAX_SITEMAP_HREFLANG_ROWS` and its byte budget.
 * A shard this size is STREAMED, in 64 KB writes that wait for the socket to
 * drain, never built whole: the fixture runs in the gate's own process, and a
 * 19 MB string per request would be the fixture's memory in the crawler's peak.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the fixture serves beyond its fixed shape. */
export interface SiteOptions {
  /** Every sitemap `<url>` carries `xhtml:link` alternates. See the header. */
  sitemapHreflang: boolean;
}

/**
 * The `GATE_SITEMAP_HREFLANG` switch: unset, empty or `0` is off, `1` is on.
 * Anything else is refused, so a typo never runs the gate in the other shape.
 */
export function sitemapHreflangSwitch(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["GATE_SITEMAP_HREFLANG"];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new RangeError(`GATE_SITEMAP_HREFLANG must be 1, 0 or unset, got ${JSON.stringify(raw)}`);
}

export interface GateSite {
  /** Origin, no trailing slash: `http://127.0.0.1:{port}`. */
  base: string;
  /** How many crawlable HTML URLs this site has, `/` included. */
  pages: number;
  /** Whether the sitemap shards carry `xhtml:link` alternates. */
  sitemapHreflang: boolean;
  /** A snapshot of what this server has answered so far. See `ServedCounts`. */
  served(): ServedCounts;
  close(): Promise<void>;
}

/**
 * Three integers, and deliberately not one per URL.
 *
 * The module header forbids this file growing state keyed by URL — that would
 * make the fixture, rather than the crawler, the thing the gate measures. Three
 * counters are O(1) for any site size and cost one increment on a path this
 * handler was already classifying, so they are inside that rule rather than an
 * exception to it.
 *
 * They exist for the phase-5 gate's politeness question. The render pass aborts
 * same-origin `image`/`media`/`font` subresources and every third-party request
 * (src/crawl/render/renderer.ts), and the only way to know an abort reached the
 * WIRE rather than merely a counter inside the renderer is to ask the server
 * what it was asked for. Every page of this fixture carries four `<img>` tags,
 * so a render phase that leaves `notFound` unmoved is the block working: those
 * `/media/…` requests would 404 here if they arrived.
 */
export interface ServedCounts {
  /** A page path that exists: `/`, `/products/pN`, `/blog/N`. */
  html: number;
  /** `robots.txt`, the sitemap index, a sitemap shard. */
  meta: number;
  /** Everything else — a `/media/…` image, `/favicon.ico`, an invented URL. */
  notFound: number;
  /** The sum. Every request this server has answered. */
  total: number;
}

/** What `respond` decided a path was, so the caller can count it. */
type ServedClass = "html" | "meta" | "notFound";

/** Internal links emitted per page. */
const LINKS_PER_PAGE = 20;

/** The stride behind the link graph. See the module header. */
const LINK_STRIDE = 7;

/** Sitemap shards under the index. */
const SITEMAP_SHARDS = 3;

/** Pages per locale cluster when `sitemapHreflang` is on. See the header. */
const LOCALE_CLUSTER = 11;

/**
 * One code per member of a locale cluster, in member order: 21, the most a
 * cluster can have (11 plus a short remainder of up to 10). Never `en` or `fr`,
 * the codes the page HTML states (see the header).
 */
const HREFLANG_LOCALES = [
  "de-DE", "de-AT", "de-CH", "es-ES", "es-MX", "it-IT", "nl-NL", "nl-BE",
  "pt-PT", "pt-BR", "pl-PL", "sv-SE", "da-DK", "fi-FI", "nb-NO", "cs-CZ",
  "hu-HU", "ro-RO", "el-GR", "tr-TR", "ja-JP",
];

/** How much shard XML is gathered before one write to the socket. */
const STREAM_WRITE_BYTES = 64 * 1024;

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
function sitemapShard(shard: number, site: Layout, base: string, opts: SiteOptions): string {
  return [...sitemapShardPieces(shard, site, base, opts)].join("");
}

/**
 * The members of `index`'s locale cluster, as a half-open index range. Clusters
 * are `LOCALE_CLUSTER` consecutive pages; the short remainder joins the last
 * full cluster, and a site smaller than one cluster is one cluster.
 */
function localeCluster(index: number, site: Layout): { start: number; end: number } {
  const clusters = Math.max(1, Math.floor(site.pages / LOCALE_CLUSTER));
  const cluster = Math.min(Math.floor(index / LOCALE_CLUSTER), clusters - 1);
  const start = cluster * LOCALE_CLUSTER;
  const end = cluster === clusters - 1 ? site.pages : start + LOCALE_CLUSTER;
  if (end - start > HREFLANG_LOCALES.length) {
    throw new Error(
      `site-server: a locale cluster of ${end - start} pages has more members than ` +
        `the ${HREFLANG_LOCALES.length} codes in HREFLANG_LOCALES`,
    );
  }
  return { start, end };
}

/** The `xhtml:link` alternates one `<url>` carries when the switch is on. */
function sitemapAlternates(index: number, site: Layout, base: string): string {
  const { start, end } = localeCluster(index, site);
  const links: string[] = [];
  for (let member = start; member < end; member++) {
    const code = HREFLANG_LOCALES[member - start] as string;
    links.push(
      `<xhtml:link rel="alternate" hreflang="${code}" href="${base}${pathOfIndex(member, site)}"/>`,
    );
  }
  links.push(
    `<xhtml:link rel="alternate" hreflang="x-default" href="${base}${pathOfIndex(start, site)}"/>`,
  );
  return links.join("");
}

/**
 * One shard as a run of pieces whose concatenation is the document: one per
 * `<url>`, plus the head and the tail. With the switch off the concatenation is
 * byte for byte the shard this fixture always served.
 */
function* sitemapShardPieces(
  shard: number,
  site: Layout,
  base: string,
  opts: SiteOptions,
): Generator<string> {
  const per = Math.ceil(site.pages / SITEMAP_SHARDS);
  const start = shard * per;
  const end = Math.min(start + per, site.pages);
  const xhtml = opts.sitemapHreflang ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : "";
  yield `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtml}>
`;
  for (let index = start; index < end; index++) {
    const alternates = opts.sitemapHreflang ? sitemapAlternates(index, site, base) : "";
    yield `${index === start ? "" : "\n"}<url><loc>${base}${pathOfIndex(index, site)}</loc>` +
      `<lastmod>2026-08-25</lastmod>${alternates}</url>`;
  }
  yield `
</urlset>
`;
}

/**
 * Write a shard to the socket in `STREAM_WRITE_BYTES` pieces, waiting for each
 * to drain, so the fixture holds O(one write) of it, never the document. A
 * client that hangs up mid-shard ends the stream there.
 */
async function streamShard(res: ServerResponse, pieces: Iterable<string>): Promise<void> {
  res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
  let batch = "";
  for (const piece of pieces) {
    batch += piece;
    if (batch.length < STREAM_WRITE_BYTES) continue;
    const flushed = res.write(batch);
    batch = "";
    if (!flushed) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
    }
    if (res.destroyed) return;
  }
  res.end(batch);
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  const buffer = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": buffer.byteLength,
  });
  res.end(buffer);
}

/**
 * The whole site as one pure function: a path in, a response out.
 *
 * It also returns what it decided the path was, so the caller can count it
 * without re-deciding — one classification, one place (see `ServedCounts`).
 */
function respond(
  path: string,
  site: Layout,
  base: string,
  opts: SiteOptions,
  res: ServerResponse,
): ServedClass {
  if (path === "/robots.txt") {
    send(res, 200, "text/plain; charset=utf-8", robotsTxt(base));
    return "meta";
  }
  if (path === "/sitemap.xml") {
    send(res, 200, "application/xml; charset=utf-8", sitemapIndex(base));
    return "meta";
  }
  const shard = /^\/sitemap-(\d+)\.xml$/.exec(path);
  if (shard !== null) {
    const n = Number(shard[1]);
    if (n < SITEMAP_SHARDS) {
      if (opts.sitemapHreflang) {
        // A rejection is left unhandled on purpose: it ends the process loudly.
        void streamShard(res, sitemapShardPieces(n, site, base, opts));
      } else {
        // Off: the response this fixture always sent, length and all.
        send(res, 200, "application/xml; charset=utf-8", sitemapShard(n, site, base, opts));
      }
      return "meta";
    }
  }

  const index = indexOfPath(path, site);
  if (index === null) {
    send(res, 404, "text/html; charset=utf-8", "<!doctype html><title>404</title><h1>Not found</h1>");
    return "notFound";
  }
  send(res, 200, "text/html; charset=utf-8", renderPage(index, site, base));
  return "html";
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
  sitemapShardPieces,
  hreflangLocales: HREFLANG_LOCALES,
};

/**
 * Start the fixture on an ephemeral loopback port.
 *
 * The listener binds 127.0.0.1 explicitly: the crawler will only be pointed at
 * this with `allowPrivate: true`, and a fixture that also answered on a routable
 * interface would be a fixture other people can reach.
 *
 * `opts` defaults to what `GATE_SITEMAP_HREFLANG` says, so every gate script
 * takes the switch from its environment without a flag of its own.
 */
export async function startSiteServer(
  pages: number,
  opts: SiteOptions = { sitemapHreflang: sitemapHreflangSwitch() },
): Promise<GateSite> {
  const site = layout(pages);
  let base = "";

  const served: ServedCounts = { html: 0, meta: 0, notFound: 0, total: 0 };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Query strings and fragments are not part of this site's URL space; the
    // path alone decides the response, which is the determinism promise.
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    served[respond(path, site, base, opts, res)] += 1;
    served.total += 1;
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
    sitemapHreflang: opts.sitemapHreflang,
    // A copy, not the live object: a caller that took two readings and got the
    // same mutable reference twice would compare a number with itself.
    served: () => ({ ...served }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

/**
 * The fixture site's static assets, and the third-party host one of them lives
 * on (P11-T2).
 *
 * Until the resource fetch pass existed, the `<img src="/img/…">` references in
 * the fixture pages pointed at nothing: the app 404'd them and no part of the
 * engine ever asked. They are now real files with real `content-type`,
 * `content-length` and `cache-control` headers, because the pass's whole output
 * is those headers — a fixture site whose assets 404 could only ever prove the
 * broken-resource path.
 *
 * The bodies are tiny hand-written SVGs. Nothing asserts about their content;
 * what matters is that a HEAD of one answers a size, which is the branch the
 * pass takes for the overwhelming majority of the real web.
 *
 * THE SECOND HOST is `startAssetHost()`: another `node:http` server on its own
 * port, which is a different origin (and a different `host`) from the fixture
 * site's even though both sit on the loopback. It is the CDN of the fixture
 * world — the hub carries one image from it — and it exists so the crawl's
 * resource pass has a genuine third-party host to open a second queue for, read
 * a second robots.txt from, and count against `maxResourceHosts`. Like
 * `startOffsiteHost` (test/fixtures/pages/render-p5.ts) it is a singleton the
 * app reads on every request and throws for when it is not running, rather than
 * serving markup that points at nowhere (hard rule 7).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface Asset {
  contentType: string;
  body: string;
  cacheControl: string | null;
}

function svg(label: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 360" role="img" ` +
    `aria-label="${label}"><rect width="720" height="360" fill="#eee"/>` +
    `<text x="24" y="180" font-size="24">${label}</text></svg>`
  );
}

/**
 * The bytes of the fixture site's one heavy image (P11-T3).
 *
 * 120,000 of them, comfortably past `IMAGE_WEIGHT_WARN` (100,000), and an exact
 * number rather than an approximate one so the harness can assert that the size
 * this server declared is the size that reached the finding — through the HEAD,
 * the fetch pass, the `resources` row and the rule.
 */
export const HEAVY_IMAGE_BYTES = 120_000;

/**
 * The heavy image's body: padding, and deliberately not a real PNG.
 *
 * Nothing in this engine decodes an image — metadata only, owner decision 2 —
 * so what makes this fixture load-bearing is its `content-type` and its
 * `content-length`, not its pixels. The body is also never transferred: the
 * resource pass sends a HEAD, this server answers with the headers and no body,
 * and the 120,000 bytes exist only to make the declared length true. Ordinary
 * ASCII, so one character is one byte and the length is the number above.
 */
function padding(bytes: number): string {
  const unit = "png-padding ";
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/**
 * The closed set the fixture site serves, one entry per path a fixture page
 * already references. Closed rather than a directory walk: a page that
 * references an asset nobody added here 404s, which is the honest answer and
 * the one the broken-resource rule (P11-T3) needs — `/authored11/broken-resource`
 * points at `/img/p11-missing.png`, which is deliberately absent from this map.
 *
 * `/img/control-outline.svg` deliberately carries NO `cache-control`, which is
 * the uncached-resource finding P11-T3 reports, on a page whose own findings
 * are asserted to be empty — a resource is not a page, and the control page's
 * silence is about its markup.
 */
const ASSETS = new Map<string, Asset>([
  [
    "/img/placeholder.svg",
    { contentType: "image/svg+xml", body: svg("Placeholder"), cacheControl: "public, max-age=3600" },
  ],
  [
    "/img/control-diagram.svg",
    { contentType: "image/svg+xml", body: svg("Control diagram"), cacheControl: "public, max-age=3600" },
  ],
  [
    "/img/control-outline.svg",
    { contentType: "image/svg+xml", body: svg("Control outline"), cacheControl: null },
  ],
  [
    "/img/authored-no-dimensions.svg",
    { contentType: "image/svg+xml", body: svg("No dimensions"), cacheControl: "public, max-age=3600" },
  ],
  // A stylesheet the server mislabels (26a): a 200 whose `content-type` is
  // `text/html`, which is what `resources.bad-content-type` reports. Cached
  // properly so it says nothing about `resources.uncached`.
  [
    "/css/p26-wrong-type.css",
    {
      contentType: "text/html; charset=utf-8",
      body: "body { color: #222; }",
      cacheControl: "public, max-age=3600",
    },
  ],
  // The heavy one (P11-T3): past the 100,000-byte line AND served as a PNG, so
  // the one file provokes both `images.oversized` and `images.legacy-format` on
  // the single page that references it. Cached properly, so it says nothing
  // about `resources.uncached` — one fixture, one signal.
  [
    "/img/p11-heavy-hero.png",
    {
      contentType: "image/png",
      body: padding(HEAVY_IMAGE_BYTES),
      cacheControl: "public, max-age=3600",
    },
  ],
]);

/**
 * Serve `path` if it is one of the fixture site's assets. Returns false when it
 * is not, so the app's own dispatch continues.
 *
 * A HEAD is answered with the headers and no body, which is what the resource
 * pass asks for and what a server that gets this wrong (no `content-length`)
 * costs an extra request.
 */
export function serveAsset(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const asset = ASSETS.get(path);
  if (asset === undefined) return false;
  const body = Buffer.from(asset.body, "utf8");
  const headers: Record<string, string> = {
    "content-type": asset.contentType,
    "content-length": String(body.length),
  };
  if (asset.cacheControl !== null) headers["cache-control"] = asset.cacheControl;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

/** The running asset host, or null before `startAssetHost` is called. */
let host: { base: string; server: Server; hits: string[] } | null = null;

export interface AssetHost {
  /** Origin, no trailing slash. A different origin from the fixture site's. */
  base: string;
  /** `method path` for every request this host answered, in order. */
  hits: string[];
  close(): Promise<void>;
}

/**
 * Start the third-party asset host.
 *
 * Its robots.txt allows everything except `/private/`, which is the same shape
 * the fixture site's own has and which nothing references — a CDN that forbids
 * a path is the ordinary case, and the pass's robots handling is exercised
 * against a host whose rules it had to go and read.
 */
export async function startAssetHost(): Promise<AssetHost> {
  if (host !== null) throw new Error("startAssetHost: the asset host is already running");
  const hits: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push(`${req.method ?? "?"} ${path}`);
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("User-agent: *\nAllow: /\nDisallow: /private/\n");
      return;
    }
    if (path === "/cdn/hub-badge.svg") {
      const body = Buffer.from(svg("Hub badge"), "utf8");
      res.writeHead(200, {
        "content-type": "image/svg+xml",
        "content-length": String(body.length),
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(req.method === "HEAD" ? undefined : "no asset here");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  host = { base, server, hits };
  return {
    base,
    hits,
    close: async () => {
      host = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

/**
 * The exact URL of the image the hub carries from the third-party host.
 *
 * Throws when the host is not running, rather than letting the hub serve an
 * `<img>` pointing at a port nobody is listening on — which would turn the one
 * third-party resource in the fixture world into a connection error and prove
 * the opposite of what it is there for.
 */
export function assetHostImage(): string {
  if (host === null) {
    throw new Error(
      "assetHostImage: the asset host is not running — call startAssetHost() before " +
        "starting the fixture app, or the hub would carry an image from nowhere",
    );
  }
  return `${host.base}/cdn/hub-badge.svg`;
}

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
 * what matters is that the Range GET the pass sends an image (29b) is answered
 * with a body whose length the pass counts, the shape of a server that ignores
 * Range.
 *
 * THE SECOND HOST is `startAssetHost()`: another `node:http` server on its own
 * port, which is a different origin (and a different `host`) from the fixture
 * site's even though both sit on the loopback. It is the CDN of the fixture
 * world — the hub carries one image from it, and since Phase 29b
 * `/p29b/cdn-image` carries a second, a raster photo — and it exists so the crawl's
 * resource pass has a genuine third-party host to open a second queue for, read
 * a second robots.txt from, and count against `maxResourceHosts`. Like
 * `startOffsiteHost` (test/fixtures/pages/render-p5.ts) it is a singleton the
 * app reads on every request and throws for when it is not running, rather than
 * serving markup that points at nowhere (hard rule 7).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pngBytes, serveImage } from "./images.js";

interface Asset {
  contentType: string;
  body: string | Buffer;
  cacheControl: string | null;
  /**
   * A real raster image, served by `serveImage` with Range honoured (206 and a
   * `Content-Range` total), the way a CDN serves a photo. Every other asset is
   * answered whole, which is the "server ignores Range" shape (Phase 29b).
   */
  raster?: boolean;
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
 * this server sent is the size that reached the finding — through the Range
 * GET, the fetch pass, the `resources` row and the rule.
 */
export const HEAVY_IMAGE_BYTES = 120_000;

/**
 * The heavy image's body: padding, and deliberately not a real PNG.
 *
 * Nothing in this engine decodes an image — metadata only, owner decision 2 —
 * so what makes this fixture load-bearing is its `content-type` and its
 * `content-length`, not its pixels. The server ignores Range, so since 29b the
 * resource pass's one Range GET gets the whole 200 body and streams it into its
 * counter (nothing is kept past the first 64 KiB, and no image is decoded).
 * Ordinary ASCII, so one character is one byte and the length is the number
 * above.
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
/**
 * The fixture site's shared image: the one `article()` puts on every healthy
 * page, and the default `og:image` `renderDocument` emits (Phase 26b), so a
 * page's share image is a real, cached, correctly typed file.
 */
export const SHARED_IMAGE_PATH = "/img/placeholder.svg";

/** Real raster fixtures and the intrinsic sizes their PNG headers carry. */
export const RASTER_LANDSCAPE_PATH = "/img/p29b-landscape.png";
export const RASTER_LANDSCAPE = { width: 1200, height: 800 } as const;
export const RASTER_SQUARE_PATH = "/img/p29b-square.png";
export const RASTER_SQUARE = { width: 600, height: 600 } as const;

/**
 * The Phase 29b image pages' files (test/fixtures/pages/authored-p29b.ts), one
 * URL per case so the request log can say which page's image was asked for and
 * by which pass. Real PNGs, Range honoured, cached, each well under
 * `IMAGE_WEIGHT_WARN`, so no weight or format rule has anything to say about
 * them: the only question they put is how wide each file is against its box.
 *
 *  - `fourX`: 1600×1200, shown in a 400×300 box (4×, past the 200% line);
 *  - `oneX`: 400×300, shown in a 400×300 box (1×);
 *  - `srcset400` / `srcset1600`: two renditions of one image. The resource pass
 *    stores only the first `srcset` candidate (and the `src`, the same file), so
 *    `srcset1600` is never asked for by anyone: the browser picks it at the
 *    1280-wide viewport and the renderer stands it in from its `w` descriptor
 *    and `srcset400`'s aspect ratio. It is served all the same, so a request for
 *    it would be a 200 in the log rather than a 404 nobody noticed;
 *  - `lazy`: 1600×1200 with `loading=lazy`, 5000px below the fold, so the
 *    renderer, which does not scroll, never requests it.
 */
export const P29B_IMAGE_PATHS = {
  fourX: "/img/p29b-4x.png",
  oneX: "/img/p29b-1x.png",
  srcset400: "/img/p29b-srcset-400.png",
  srcset1600: "/img/p29b-srcset-1600.png",
  lazy: "/img/p29b-lazy.png",
} as const;
export const P29B_LARGE = { width: 1600, height: 1200 } as const;
export const P29B_SMALL = { width: 400, height: 300 } as const;

/** One cached, Range-honouring PNG of `size`. */
function raster(size: { width: number; height: number }): Asset {
  return {
    contentType: "image/png",
    body: pngBytes(size.width, size.height),
    cacheControl: "public, max-age=3600",
    raster: true,
  };
}

const ASSETS = new Map<string, Asset>([
  [
    SHARED_IMAGE_PATH,
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
  // Real PNGs at known sizes (29b), so the resource pass has intrinsic sizes to
  // record and the renderer real dimensions to stand in. Range is honoured on
  // these paths and on no other. Fixture pages reference them from Task 8 on.
  [
    RASTER_LANDSCAPE_PATH,
    {
      contentType: "image/png",
      body: pngBytes(RASTER_LANDSCAPE.width, RASTER_LANDSCAPE.height),
      cacheControl: "public, max-age=3600",
      raster: true,
    },
  ],
  [
    RASTER_SQUARE_PATH,
    {
      contentType: "image/png",
      body: pngBytes(RASTER_SQUARE.width, RASTER_SQUARE.height),
      cacheControl: "public, max-age=3600",
      raster: true,
    },
  ],
  // The Phase 29b image pages' files, described at `P29B_IMAGE_PATHS`.
  [P29B_IMAGE_PATHS.fourX, raster(P29B_LARGE)],
  [P29B_IMAGE_PATHS.oneX, raster(P29B_SMALL)],
  [P29B_IMAGE_PATHS.srcset400, raster(P29B_SMALL)],
  [P29B_IMAGE_PATHS.srcset1600, raster(P29B_LARGE)],
  [P29B_IMAGE_PATHS.lazy, raster(P29B_LARGE)],
]);

/**
 * Serve `path` if it is one of the fixture site's assets. Returns false when it
 * is not, so the app's own dispatch continues.
 *
 * A HEAD is answered with the headers and no body, which is what the resource
 * pass asks for of css and js. An image is asked with a Range GET (29b): the
 * raster assets honour it (206), and every other asset ignores it and answers
 * 200 with the whole body.
 */
export function serveAsset(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const asset = ASSETS.get(path);
  if (asset === undefined) return false;
  if (asset.raster === true) {
    serveImage(req, res, {
      bytes: Buffer.from(asset.body),
      contentType: asset.contentType,
      range: "honour",
      ...(asset.cacheControl === null ? {} : { cacheControl: asset.cacheControl }),
    });
    return true;
  }
  const body = typeof asset.body === "string" ? Buffer.from(asset.body, "utf8") : asset.body;
  const headers: Record<string, string> = {
    "content-type": asset.contentType,
    "content-length": String(body.length),
  };
  if (asset.cacheControl !== null) headers["cache-control"] = asset.cacheControl;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

/**
 * The Phase 29b CDN photo: 1600×1200, shown on `/p29b/cdn-image` in a 400×300
 * box (4×). The asset host's only raster file.
 */
export const P29B_CDN_IMAGE_PATH = "/cdn/p29b-photo.png";
const CDN_PHOTO = pngBytes(P29B_LARGE.width, P29B_LARGE.height);

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
    if (path === P29B_CDN_IMAGE_PATH) {
      // Phase 29b: a photo on the CDN, served the way a CDN serves one — Range
      // honoured (206 with a `Content-Range` total) and cached for a year — so
      // the resource pass reads its size from the first 64 KiB of a third-party
      // host and the renderer can stand it in without asking that host at all.
      serveImage(req, res, {
        bytes: CDN_PHOTO,
        contentType: "image/png",
        range: "honour",
        cacheControl: "public, max-age=31536000, immutable",
      });
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

/**
 * The exact URL of the Phase 29b CDN photo (`P29B_CDN_IMAGE_PATH`). Throws when
 * the host is not running, for the reason `assetHostImage` does.
 */
export function assetHostRaster(): string {
  if (host === null) {
    throw new Error(
      "assetHostRaster: the asset host is not running — call startAssetHost() before " +
        "starting the fixture app, or /p29b/cdn-image would carry an image from nowhere",
    );
  }
  return `${host.base}${P29B_CDN_IMAGE_PATH}`;
}

/**
 * Image stand-ins and the per-`<img>` measurement of the render pass
 * (Phase 29b, `pages.render_images`, render capture 3).
 *
 * THE PROBLEM. Until 29b the renderer aborted every image as paint-only: an
 * image cannot move `innerText` or an anchor count, and each one skipped was
 * one fewer request at a client's server. But an aborted image has no
 * intrinsic size, so a box sized by its image (`width: 400px; height: auto`, or
 * no CSS at all) lays out wrong, and the one question an image's box answers —
 * "is this file much wider than the space it is shown in?" — could not be
 * asked.
 *
 * THE ANSWER, without fetching a single image. The resource pass already read
 * each image's intrinsic size from its format header (Tasks 1–2,
 * `resources.width/height`). The renderer answers an image request whose URL
 * has a stored size with a BLANK SVG of exactly that size (`standInSvg`), from
 * its own interception layer: the browser lays the page out as the real image
 * would, nothing reaches any host, and the box can be measured against the
 * stored size afterwards (`IMAGES_MEASURE_SCRIPT`, `classifyImages`).
 *
 * A RESPONSIVE IMAGE (`srcset` with `w` descriptors, ruling R6) usually has
 * only one rendition stored — the resource pass fetches the `src` and the
 * first candidate. When the browser picks another candidate, the renderer asks
 * the page which `srcset` named it (`SRCSET_LOOKUP_SCRIPT`): the candidate's
 * `w` descriptor IS its intrinsic width (the HTML spec's definition of it), and
 * the height follows the aspect ratio of the first sibling candidate with a
 * stored size (`srcsetStandIn`). With no such sibling the request is aborted
 * as before: a guessed height would move the layout.
 *
 * Everything here is pure (the scripts are strings evaluated in the page), so
 * the arithmetic is unit-tested without a browser; renderer.ts wires it in.
 */
import { storableText } from "../storable-text.js";
import { RENDER_CONSOLE_MAX_CHARS } from "./console-capture.js";

/**
 * `<img>` elements measured per page, in document order (ruling R9). `total`
 * still counts every one, so a page past the cap shows the gap.
 */
export const MAX_RENDER_IMAGES = 1000;

/**
 * Images kept per page in `kept`: the ones whose intrinsic width exceeds their
 * displayed width, worst waste first (ruling R1). A rule that applies its own
 * ratio over them says "at least" when `widerThanDisplayed` is larger.
 */
export const RENDER_IMAGES_KEPT = 50;

/**
 * Sibling candidates the srcset lookup hands back for one request, in
 * attribute order. Bounds the lookup query a hostile `srcset` can cause; a
 * stored sibling past it is not found and the request is aborted (counted
 * as `noDimensions`), which is visible rather than guessed.
 */
export const SRCSET_MAX_SIBLINGS = 32;

/**
 * The largest dimension a stand-in is made for: Postgres `integer`'s bound,
 * which is also the resource pass's bound on a stored size (Task 2, S2).
 */
const MAX_DIMENSION = 2_147_483_647;

/** An image's intrinsic size as the resource pass stored it, with its transferred bytes. */
export interface StoredImage {
  width: number;
  height: number;
  bytes: number | null;
}

/**
 * Looks normalised image URLs up in this crawl's `resources` (`normalizeUrl`
 * output, the table's key) and answers the ones that HAVE a stored size. A
 * URL absent from the answer has none. Rejects only for a defect of ours (a
 * failed query), which the renderer lets stop the render (ruling R5).
 */
export type ImageDimensionLookup = (
  normalisedUrls: readonly string[],
) => Promise<ReadonlyMap<string, StoredImage>>;

/**
 * Lookups one render may have waiting on the database at once (M2). A page
 * looping `new Image().src = "/x?" + i` pauses one image request per
 * iteration; each would otherwise take a pool connection of the pass.
 */
export const IMAGE_LOOKUP_CONCURRENCY = 4;

/**
 * The per-render face of an `ImageDimensionLookup` (M2): each normalised URL
 * is asked for ONCE per render (a URL asked again shares the first answer),
 * and at most `concurrency` calls wait on `lookup` at a time; the rest queue
 * in arrival order. Built per render and dropped with it, so what it
 * remembers is O(one page's image URLs) (rule 6). A rejection reaches every
 * caller of the URLs in that call: it is ours.
 */
export function perRenderLookup(
  lookup: ImageDimensionLookup,
  concurrency: number = IMAGE_LOOKUP_CONCURRENCY,
): ImageDimensionLookup {
  const known = new Map<string, Promise<StoredImage | undefined>>();
  let running = 0;
  const queued: Array<() => void> = [];
  const claim = async (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return;
    }
    // Handed over by `free`, still counted in `running`.
    await new Promise<void>((resolve) => queued.push(resolve));
  };
  const free = (): void => {
    const next = queued.shift();
    if (next === undefined) running -= 1;
    else next();
  };
  return async (urls) => {
    const missing = [...new Set(urls)].filter((url) => !known.has(url));
    if (missing.length > 0) {
      const call = (async () => {
        await claim();
        try {
          return await lookup(missing);
        } finally {
          free();
        }
      })();
      for (const url of missing) known.set(url, call.then((found) => found.get(url)));
    }
    const answers = await Promise.all(urls.map((url) => known.get(url)!));
    const found = new Map<string, StoredImage>();
    urls.forEach((url, i) => {
      const image = answers[i];
      if (image !== undefined) found.set(url, image);
    });
    return found;
  };
}

function isDimension(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION;
}

/**
 * One answer of an `ImageDimensionLookup`, checked, or THROW. The lookup is
 * ours (a query over `resources`, whose writer stores only positive sizes
 * within `integer`), so a size that is not one is our defect, and it stops the
 * render rather than becoming an SVG nobody can lay out.
 */
export function checkStoredImage(image: StoredImage, url: string): StoredImage {
  const bytesOk =
    image.bytes === null || (Number.isSafeInteger(image.bytes) && image.bytes >= 0);
  if (!isDimension(image.width) || !isDimension(image.height) || !bytesOk) {
    throw new Error(
      `image dimension lookup answered an impossible size for ${url}: ` +
        `${image.width}×${image.height}, ${image.bytes} bytes`,
    );
  }
  return { width: image.width, height: image.height, bytes: image.bytes };
}

/**
 * The stand-in body: an empty SVG whose `width`/`height` attributes give the
 * browser exactly the intrinsic size of the real image. Nothing is painted.
 * The stored size is already the DISPLAYED one — a JPEG or AVIF that asks to
 * be turned a quarter is stored with its sides swapped (`readImageSize`) — and
 * an SVG carries no orientation, so it is laid out as the real file would be.
 */
export function standInSvg(width: number, height: number): string {
  if (!isDimension(width) || !isDimension(height)) {
    throw new RangeError(`standInSvg: a size must be a positive integer, got ${width}×${height}`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`;
}

/**
 * A stand-in for a `srcset` candidate whose `w` descriptor is `width`, shaped
 * like `sibling` (a stored rendition of the same image): or null when the
 * derived height is not a usable size, because a guessed one would move the
 * layout (R6).
 */
export function srcsetStandIn(
  width: number,
  sibling: StoredImage,
): (StoredImage & { widthFrom: "srcset-w" }) | null {
  const height = Math.round((width * sibling.height) / sibling.width);
  if (!isDimension(width) || !isDimension(height)) return null;
  // The bytes are the PICKED rendition's, which nobody fetched: unknown.
  return { width, height, bytes: null, widthFrom: "srcset-w" };
}

/**
 * `(requestUrl) => {w, candidates} | null`, as a function EXPRESSION to be
 * called in the page's main frame with the request URL as a JSON string
 * literal.
 *
 * It looks through every `img[srcset]` and `source[srcset]` for a candidate
 * whose URL, resolved against the document's base URL and without its
 * fragment, is `requestUrl`. The first one found answers: `w` is its width
 * descriptor (null for a density or bare candidate), `candidates` are the
 * other candidates of the same attribute, resolved, deduplicated, at most
 * `SRCSET_MAX_SIBLINGS`. No element names it: null. When two attributes list
 * the same URL with different `w` descriptors (the page contradicting itself),
 * the first in document order wins.
 *
 * WHILE THE DOCUMENT IS STILL BEING PARSED, a miss is not final, and the
 * answer is a Promise (the caller evaluates with `awaitPromise`). The
 * browser's preload scanner requests a parser-seen image AHEAD of the tree
 * builder — measured: about one render in four of a one-image page, the
 * request paused before its `<img>` existed — and the element then adopts
 * that very request. So a miss while `readyState` is `loading` is searched
 * once more when the parser is done (`readystatechange` away from
 * `loading`), when every element of the markup exists. That is the parser's
 * own completion, not a timer. A request from script or from an element made
 * after parsing always has its element already. A page that never finishes
 * parsing leaves the lookup waiting until the render closes it, which is
 * then a miss (renderer.ts). The wait is paid by EVERY main-frame image
 * request with no stored size, not only by srcset ones — cross-origin ones
 * included — since only the search can tell them apart: such a request is
 * failed when the parser is done rather than at once. It holds nothing but
 * itself.
 *
 * THE PARSER IS THE HTML SPEC'S "parse a srcset attribute" algorithm, step for
 * step (splitting loop, URL collection with trailing-comma removal, the
 * descriptor tokenizer's three states, the descriptor parser with its error
 * rules), because the browser picked the candidate by that algorithm and a
 * looser split would match a different one — a comma inside a URL is legal
 * and a split on commas would cut it.
 */
export const SRCSET_LOOKUP_SCRIPT = `function (requestUrl) {
  var MAX_SIBLINGS = ${SRCSET_MAX_SIBLINGS};
  function isSpace(c) { return c === " " || c === "\\t" || c === "\\n" || c === "\\f" || c === "\\r"; }
  var NON_NEGATIVE_INTEGER = /^[0-9]+$/;
  var FLOATING_POINT = /^-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
  function parseDescriptors(descriptors) {
    var error = false, width = null, density = null, futureH = null;
    for (var i = 0; i < descriptors.length; i += 1) {
      var d = descriptors[i];
      var last = d.charAt(d.length - 1);
      var value = d.slice(0, -1);
      if (last === "w" && NON_NEGATIVE_INTEGER.test(value)) {
        if (width !== null || density !== null) error = true;
        var w = parseInt(value, 10);
        if (w === 0) error = true; else width = w;
      } else if (last === "x" && FLOATING_POINT.test(value)) {
        if (width !== null || density !== null || futureH !== null) error = true;
        var x = parseFloat(value);
        if (x < 0) error = true; else density = x;
      } else if (last === "h" && NON_NEGATIVE_INTEGER.test(value)) {
        if (futureH !== null || density !== null) error = true;
        var h = parseInt(value, 10);
        if (h === 0) error = true; else futureH = h;
      } else {
        error = true;
      }
    }
    if (futureH !== null && width === null) error = true;
    return error ? null : { w: width };
  }
  function parseSrcset(input) {
    var candidates = [];
    var pos = 0;
    var len = input.length;
    for (;;) {
      while (pos < len && (isSpace(input.charAt(pos)) || input.charAt(pos) === ",")) pos += 1;
      if (pos >= len) return candidates;
      var start = pos;
      while (pos < len && !isSpace(input.charAt(pos))) pos += 1;
      var url = input.slice(start, pos);
      var descriptors = [];
      if (url.charAt(url.length - 1) === ",") {
        url = url.replace(/,+$/, "");
      } else {
        while (pos < len && isSpace(input.charAt(pos))) pos += 1;
        var current = "";
        var state = "in";
        for (;;) {
          var c = pos < len ? input.charAt(pos) : null;
          if (state === "in") {
            if (c !== null && isSpace(c)) {
              if (current !== "") { descriptors.push(current); current = ""; state = "after"; }
            } else if (c === ",") {
              pos += 1;
              if (current !== "") descriptors.push(current);
              break;
            } else if (c === "(") {
              current += c; state = "parens";
            } else if (c === null) {
              if (current !== "") descriptors.push(current);
              break;
            } else {
              current += c;
            }
          } else if (state === "parens") {
            if (c === ")") { current += c; state = "in"; }
            else if (c === null) { descriptors.push(current); break; }
            else current += c;
          } else {
            if (c === null) break;
            if (!isSpace(c)) { state = "in"; pos -= 1; }
          }
          pos += 1;
        }
      }
      var parsed = parseDescriptors(descriptors);
      if (parsed !== null) candidates.push({ url: url, w: parsed.w });
    }
  }
  function resolve(url, base) {
    try {
      var u = new URL(url, base);
      u.hash = "";
      return u.href;
    } catch (e) {
      return null;
    }
  }
  function search() {
    var base = document.baseURI;
    var elements = document.querySelectorAll("img[srcset], source[srcset]");
    for (var i = 0; i < elements.length; i += 1) {
      var list = parseSrcset(elements[i].getAttribute("srcset") || "");
      var resolved = [];
      for (var j = 0; j < list.length; j += 1) {
        var abs = resolve(list[j].url, base);
        if (abs !== null) resolved.push({ url: abs, w: list[j].w });
      }
      for (var k = 0; k < resolved.length; k += 1) {
        if (resolved[k].url !== requestUrl) continue;
        var siblings = [];
        for (var m = 0; m < resolved.length && siblings.length < MAX_SIBLINGS; m += 1) {
          var s = resolved[m].url;
          if (s !== requestUrl && siblings.indexOf(s) === -1) siblings.push(s);
        }
        return { w: resolved[k].w, candidates: siblings };
      }
    }
    return null;
  }
  var found = search();
  if (found !== null || document.readyState !== "loading") return found;
  return new Promise(function (settle) {
    function parsed() {
      if (document.readyState === "loading") return;
      document.removeEventListener("readystatechange", parsed);
      settle(search());
    }
    document.addEventListener("readystatechange", parsed);
  });
}`;

/** What the srcset lookup answered, checked. */
export interface SrcsetMatch {
  w: number | null;
  candidates: string[];
}

/**
 * The srcset lookup's value, checked — or null for "no match" AND for any
 * shape the script could not have produced. The renderer runs the script in an
 * isolated world, whose globals the page cannot reach, so a bent value is not
 * expected; checked anyway, because the DOM it reads is still the page's, and
 * a value that is not a size costs one unmeasured image (the request is then
 * aborted and counted as `noDimensions`), never the render.
 */
export function readSrcsetReply(value: unknown): SrcsetMatch | null {
  if (value === null || typeof value !== "object") return null;
  const { w, candidates } = value as { w?: unknown; candidates?: unknown };
  if (w !== null && !isDimension(w)) return null;
  if (!Array.isArray(candidates) || candidates.length > SRCSET_MAX_SIBLINGS) return null;
  if (!candidates.every((c): c is string => typeof c === "string")) return null;
  return { w, candidates: [...candidates] };
}

/**
 * `() => {total, rows}`, as an expression: the first `MAX_RENDER_IMAGES`
 * `<img>` elements of the main document, in document order, each as
 * `[currentSrc without its fragment, box width, box height, loading, broken]`.
 * The box is `getBoundingClientRect`, rounded to whole CSS pixels; `loading`
 * is the reflected IDL value (`lazy` or `eager`); `broken` is
 * `complete && naturalWidth === 0` — the browser finished with the image and
 * has nothing to show (I1).
 *
 * The renderer evaluates it in an ISOLATED WORLD (renderer.ts), so a page
 * that replaced `Array.prototype.push` or `getBoundingClientRect` in its own
 * world can neither break nor falsify it: the DOM is shared, the globals and
 * prototype objects are not.
 *
 * NOT SEEN: an `<img>` inside a shadow root. `getElementsByTagName` does not
 * cross shadow boundaries, so such images are in neither `total` nor any
 * bucket (their requests are still answered and counted in `standIns`).
 */
export const IMAGES_MEASURE_SCRIPT = `(() => {
  const images = document.getElementsByTagName("img");
  const total = images.length;
  const rows = [];
  for (let i = 0; i < total && i < ${MAX_RENDER_IMAGES}; i += 1) {
    const img = images[i];
    const box = img.getBoundingClientRect();
    const src = img.currentSrc;
    const hash = src.indexOf("#");
    rows.push([
      hash === -1 ? src : src.slice(0, hash),
      Math.round(box.width),
      Math.round(box.height),
      String(img.loading),
      img.complete && img.naturalWidth === 0,
    ]);
  }
  return { total, rows };
})()`;

/** What `IMAGES_MEASURE_SCRIPT` hands back. */
export interface ImageMeasurement {
  total: number;
  rows: [string, number, number, string, boolean][];
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * The measurement's value, checked, or THROW naming what came back. It runs in
 * an isolated world the page cannot reach, so a wrong shape is not expected;
 * the renderer evaluates it in phase 1, where a throw is classified rather
 * than recorded as a measurement nobody took.
 */
export function readImageMeasurement(value: unknown): ImageMeasurement {
  const bad = (): Error =>
    new Error(
      `image measurement returned an unexpected shape: ${JSON.stringify(value)?.slice(0, 200)}`,
    );
  if (value === null || typeof value !== "object") throw bad();
  const { total, rows } = value as { total?: unknown; rows?: unknown };
  if (!isCount(total) || !Array.isArray(rows)) throw bad();
  if (rows.length > Math.min(total, MAX_RENDER_IMAGES)) throw bad();
  for (const row of rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 5 ||
      typeof row[0] !== "string" ||
      !isCount(row[1]) ||
      !isCount(row[2]) ||
      typeof row[3] !== "string" ||
      typeof row[4] !== "boolean"
    ) {
      throw bad();
    }
  }
  return { total, rows: rows as ImageMeasurement["rows"] };
}

/** One measured image whose intrinsic width exceeds its displayed width. */
export interface RenderImage {
  /** `currentSrc` without its fragment, made storable and capped as the console's URLs are. */
  url: string;
  /** True when `url` was cut to `RENDER_CONSOLE_MAX_CHARS`. */
  cut: boolean;
  intrinsicWidth: number;
  intrinsicHeight: number;
  /** The `<img>` box in CSS px at the fixed 1280×900 viewport, DPR 1. */
  displayedWidth: number;
  displayedHeight: number;
  /**
   * `max(0, intrinsic area − displayed area)`. A page-declared `w` descriptor
   * is bounded at Postgres `integer` only, so on an absurd one the area can
   * pass 2^53 and this is then a double, not an exact count.
   */
  wastedPixels: number;
  /** The stored transferred size; null for a `srcset-w` stand-in, whose file nobody fetched. */
  bytes: number | null;
  /** `stored`: the resource pass read the size. `srcset-w`: the candidate's `w` descriptor (R6). */
  widthFrom: "stored" | "srcset-w";
}

/**
 * One render's images, as `pages.render_images` stores them. Every count is
 * over the `examined` rows; `total - examined` were past `MAX_RENDER_IMAGES`.
 * Each examined image is in exactly one of `hidden`, `lazyUnloaded`,
 * `notRequested`, `measured`, `broken` and `noDimensions`.
 */
export interface RenderImages {
  /** Every `<img>` in the main document. */
  total: number;
  /** The ones measured: the first `MAX_RENDER_IMAGES`. */
  examined: number;
  /** Answered with a stand-in and laid out at a box of at least 1×1. */
  measured: number;
  /** A box under 1×1 (display:none, collapsed, zero-sized). */
  hidden: number;
  /** Never requested and `loading=lazy`: below the fold of a renderer that does not scroll. */
  lazyUnloaded: number;
  /** Never requested otherwise (no source, an unsupported type, a srcset the page never chose). */
  notRequested: number;
  /**
   * Requested, but no size was known for it, so it was aborted as before 29b.
   * Also an image whose lookup was still running when the page was measured:
   * it had no stand-in yet, so it is counted here rather than guessed.
   */
  noDimensions: number;
  /**
   * A stand-in WAS served and the browser could not display it (`complete`
   * with `naturalWidth` 0) — e.g. a cors-mode request the answer did not
   * satisfy. Never `measured`: its box is the broken-image glyph, not the
   * image's.
   */
  broken: number;
  /** Of `measured`, the images whose intrinsic width exceeds their displayed width. */
  widerThanDisplayed: number;
  /** Distinct image URLs this render answered with a stand-in (any image, `<img>` or not). */
  standIns: number;
  /** The `RENDER_IMAGES_KEPT` worst of `widerThanDisplayed`, by wasted pixels, then bytes, then url. */
  kept: RenderImage[];
}

/**
 * Sort each measured `<img>` into exactly one bucket, in this order (the
 * first that applies wins):
 *
 *  1. a box under 1×1 → `hidden` (nothing is shown, so nothing is wasted on screen);
 *  2. its `currentSrc` was never requested → `lazyUnloaded` when it is
 *     `loading=lazy`, else `notRequested`;
 *  3. it was answered with a stand-in → `broken` when the browser could not
 *     display it, else `measured`;
 *  4. otherwise → `noDimensions` (requested and aborted).
 *
 * `served` and `requested` are keyed by the request URL without its fragment,
 * which is what `currentSrc` without its fragment is.
 */
export function classifyImages(
  measured: { total: number; rows: [string, number, number, string, boolean][] },
  served: ReadonlyMap<string, StoredImage & { widthFrom: RenderImage["widthFrom"] }>,
  requested: ReadonlySet<string>,
): RenderImages {
  const out: Omit<RenderImages, "kept"> = {
    total: measured.total,
    examined: measured.rows.length,
    measured: 0,
    hidden: 0,
    lazyUnloaded: 0,
    notRequested: 0,
    noDimensions: 0,
    broken: 0,
    widerThanDisplayed: 0,
    standIns: served.size,
  };
  const wider: Array<Omit<RenderImage, "url" | "cut"> & { rawUrl: string }> = [];
  for (const [src, displayedWidth, displayedHeight, loading, broken] of measured.rows) {
    if (displayedWidth < 1 || displayedHeight < 1) {
      out.hidden += 1;
      continue;
    }
    if (!requested.has(src)) {
      if (loading === "lazy") out.lazyUnloaded += 1;
      else out.notRequested += 1;
      continue;
    }
    const image = served.get(src);
    if (image === undefined) {
      out.noDimensions += 1;
      continue;
    }
    if (broken) {
      out.broken += 1;
      continue;
    }
    out.measured += 1;
    if (image.width <= displayedWidth) continue;
    out.widerThanDisplayed += 1;
    wider.push({
      rawUrl: src,
      intrinsicWidth: image.width,
      intrinsicHeight: image.height,
      displayedWidth,
      displayedHeight,
      wastedPixels: Math.max(0, image.width * image.height - displayedWidth * displayedHeight),
      bytes: image.bytes,
      widthFrom: image.widthFrom,
    });
  }
  wider.sort(
    (a, b) =>
      b.wastedPixels - a.wastedPixels ||
      (b.bytes ?? -1) - (a.bytes ?? -1) ||
      (a.rawUrl < b.rawUrl ? -1 : a.rawUrl > b.rawUrl ? 1 : 0),
  );
  const kept = wider.slice(0, RENDER_IMAGES_KEPT).map(({ rawUrl, ...image }): RenderImage => {
    const url = storableText(rawUrl, RENDER_CONSOLE_MAX_CHARS);
    return {
      url: url.text,
      cut: url.cut,
      intrinsicWidth: image.intrinsicWidth,
      intrinsicHeight: image.intrinsicHeight,
      displayedWidth: image.displayedWidth,
      displayedHeight: image.displayedHeight,
      wastedPixels: image.wastedPixels,
      bytes: image.bytes,
      widthFrom: image.widthFrom,
    };
  });
  return { ...out, kept };
}

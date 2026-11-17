/**
 * Intrinsic image size from the first 64 KiB of a response body.
 *
 * Pure: no I/O, no dependencies, and it never decodes a pixel. It reads the
 * width and height a format records in its own header, which is what the
 * browser would use as the image's intrinsic size. Written from the format
 * specs (PNG per the W3C spec, JPEG per ITU T.81 markers, GIF89a, the WebP
 * RIFF container per RFC 9649, and ISOBMFF boxes with the HEIF `ispe`
 * property for AVIF). Nothing is lifted from any library (hard rule 8).
 *
 * NO GUESSING. A size that cannot be read is `{kind:"none", reason}`, with the
 * reason saying why, never a default dimension. The reasons:
 *   - `empty`               zero bytes;
 *   - `svg`                 a vector format with no intrinsic pixel size;
 *   - `unknown-format`      no known signature (the content type is not trusted
 *                           to name a raster format: bytes decide);
 *   - `header-beyond-limit` the structure is sound so far but runs past the
 *                           bytes we hold before any size appears (a JPEG with
 *                           a huge APP segment, an AVIF with a big `meta`);
 *   - `malformed`           the structure is wrong or a dimension is 0.
 *
 * Every read is bounds-checked against `head.length`, and the function never
 * throws on any input: a fuzz test pins that.
 */

/** How many leading bytes of an image the resource pass keeps for this parser. */
export const IMAGE_HEADER_BYTES = 65_536;

export type ImageSize =
  | { kind: "size"; format: "png" | "jpeg" | "gif" | "webp" | "avif"; width: number; height: number }
  | { kind: "none"; reason: "svg" | "unknown-format" | "header-beyond-limit" | "malformed" | "empty" };

type NoneReason = Extract<ImageSize, { kind: "none" }>["reason"];
type Format = Extract<ImageSize, { kind: "size" }>["format"];

const none = (reason: NoneReason): ImageSize => ({ kind: "none", reason });

/** A found size, or malformed when either dimension is 0. */
function size(format: Format, width: number, height: number): ImageSize {
  if (width <= 0 || height <= 0) return none("malformed");
  return { kind: "size", format, width, height };
}

const u8 = (b: Uint8Array, o: number): number => b[o] ?? 0;
const be16 = (b: Uint8Array, o: number): number => (u8(b, o) << 8) | u8(b, o + 1);
const be32 = (b: Uint8Array, o: number): number =>
  ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;
const le16 = (b: Uint8Array, o: number): number => u8(b, o) | (u8(b, o + 1) << 8);
const le24 = (b: Uint8Array, o: number): number => u8(b, o) | (u8(b, o + 1) << 8) | (u8(b, o + 2) << 16);
const le32 = (b: Uint8Array, o: number): number =>
  (u8(b, o) | (u8(b, o + 1) << 8) | (u8(b, o + 2) << 16) | (u8(b, o + 3) << 24)) >>> 0;

/** True when `b` has `bytes` at `at`, and holds all of them (no partial match). */
function hasAt(b: Uint8Array, at: number, bytes: readonly number[]): boolean {
  if (at < 0 || at + bytes.length > b.length) return false;
  for (let i = 0; i < bytes.length; i++) if (b[at + i] !== bytes[i]) return false;
  return true;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const fourcc = (b: Uint8Array, at: number, s: string): boolean => hasAt(b, at, ascii(s));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** SVG: the declared type, or a leading `<svg` / `<?xml` after a BOM and whitespace. */
function looksLikeSvg(head: Uint8Array, contentType: string | null): boolean {
  if (contentType !== null && contentType.split(";")[0]!.trim().toLowerCase() === "image/svg+xml") return true;
  let i = 0;
  if (hasAt(head, 0, [0xef, 0xbb, 0xbf])) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  return fourcc(head, i, "<svg") || fourcc(head, i, "<?xml");
}

function readPng(head: Uint8Array): ImageSize {
  // Signature (8), IHDR length (4), "IHDR" (4), width (4), height (4).
  if (head.length < 24 || !fourcc(head, 12, "IHDR")) return none("malformed");
  return size("png", be32(head, 16), be32(head, 20));
}

function readGif(head: Uint8Array): ImageSize {
  // "GIF8?a" (6), then the logical screen width and height, little-endian.
  if (head.length < 10) return none("malformed");
  return size("gif", le16(head, 6), le16(head, 8));
}

/** SOF0-SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function readJpeg(head: Uint8Array): ImageSize {
  let pos = 2; // past SOI
  for (;;) {
    // Find the next marker: 0xFF, then any number of 0xFF fill bytes.
    while (pos < head.length && head[pos] !== 0xff) pos++;
    while (pos < head.length && head[pos] === 0xff) pos++;
    if (pos >= head.length) return none("header-beyond-limit");
    const marker = head[pos]!;
    pos++;
    if (marker === 0x00) continue; // a stuffed zero, not a marker
    // Standalone markers carry no length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // EOI or SOS before any SOF: the frame header never came.
    if (marker === 0xd9 || marker === 0xda) return none("malformed");
    if (pos + 2 > head.length) return none("header-beyond-limit");
    const length = be16(head, pos);
    if (length < 2) return none("malformed");
    if (isSof(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (length < 7) return none("malformed");
      if (pos + 7 > head.length) return none("header-beyond-limit");
      return size("jpeg", be16(head, pos + 5), be16(head, pos + 3));
    }
    if (pos + length > head.length) return none("header-beyond-limit");
    pos += length;
  }
}

function readWebp(head: Uint8Array): ImageSize {
  // RIFF (4) size (4) "WEBP" (4), then the first chunk's fourcc at 12 and its data at 20.
  if (!fourcc(head, 8, "WEBP") || head.length < 20) return none("malformed");
  if (fourcc(head, 12, "VP8 ")) {
    // Frame tag (3), start code 9d 01 2a (3), then 14-bit width and height.
    if (head.length < 30) return none("malformed");
    if (!hasAt(head, 23, [0x9d, 0x01, 0x2a])) return none("malformed");
    return size("webp", le16(head, 26) & 0x3fff, le16(head, 28) & 0x3fff);
  }
  if (fourcc(head, 12, "VP8L")) {
    // Signature 0x2f, then 14 bits of (width-1) and 14 bits of (height-1).
    if (head.length < 25) return none("malformed");
    if (head[20] !== 0x2f) return none("malformed");
    const bits = le32(head, 21);
    return size("webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (fourcc(head, 12, "VP8X")) {
    // Flags (4), then 24-bit canvas (width-1) and (height-1).
    if (head.length < 30) return none("malformed");
    return size("webp", le24(head, 24) + 1, le24(head, 27) + 1);
  }
  return none("malformed");
}

/** One ISOBMFF box header inside `[pos, limit)`. */
type BoxHeader = { type: string; body: number; end: number };

/**
 * The box at `pos`, or why there is none. `end` is the box's declared end and
 * may lie past `head.length`; callers decide what that means. A header that
 * does not fit in `limit` is `beyond`, a size that contradicts itself is `bad`.
 */
function boxAt(head: Uint8Array, pos: number, limit: number): BoxHeader | "beyond" | "bad" {
  if (pos + 8 > limit) return "beyond";
  let boxSize = be32(head, pos);
  let body = pos + 8;
  if (boxSize === 1) {
    // 64-bit largesize: the high word must be 0 for any box we could ever hold.
    if (pos + 16 > limit) return "beyond";
    if (be32(head, pos + 8) !== 0) return "beyond";
    boxSize = be32(head, pos + 12);
    body = pos + 16;
  } else if (boxSize === 0) {
    boxSize = Number.MAX_SAFE_INTEGER - pos; // extends to the end of the file
  }
  if (boxSize < body - pos) return "bad";
  const type = String.fromCharCode(u8(head, pos + 4), u8(head, pos + 5), u8(head, pos + 6), u8(head, pos + 7));
  return { type, body, end: pos + boxSize };
}

/**
 * Walk the children in `[from, to)` for the first box of `type`, descending
 * through `path`. Returns the size, or the reason none was found.
 */
function findIspe(head: Uint8Array, from: number, to: number, path: readonly string[]): ImageSize | null {
  const want = path[0]!;
  let pos = from;
  while (pos < to) {
    const b = boxAt(head, pos, Math.min(to, head.length));
    if (b === "beyond") return none("header-beyond-limit");
    if (b === "bad") return none("malformed");
    if (b.type === want) {
      if (path.length === 1) {
        // ispe is a full box: version/flags (4), then width (4) and height (4).
        if (b.body + 12 > head.length) return none("header-beyond-limit");
        return size("avif", be32(head, b.body + 4), be32(head, b.body + 8));
      }
      // `meta` is a full box (4 bytes of version/flags before its children).
      const childrenAt = want === "meta" ? b.body + 4 : b.body;
      const found = findIspe(head, childrenAt, Math.min(b.end, head.length), path.slice(1));
      if (found !== null) {
        // A container that ended in bounds without the target is malformed, but
        // one that ran past our bytes is beyond the limit: findIspe says which.
        return found;
      }
    }
    if (b.end > head.length && b.end > to) return none("header-beyond-limit");
    pos = b.end;
  }
  return null;
}

function readAvif(head: Uint8Array): ImageSize {
  const ftyp = boxAt(head, 0, head.length);
  if (ftyp === "beyond") return none("header-beyond-limit");
  if (ftyp === "bad" || ftyp.type !== "ftyp") return none("malformed");
  const result = findIspe(head, 0, head.length, ["meta", "iprp", "ipco", "ispe"]);
  // Walked every box in bounds and no ispe: the file has no size to report.
  return result ?? none("malformed");
}

/** An ISOBMFF `ftyp` naming an AVIF brand (major or compatible). */
function isAvif(head: Uint8Array): boolean {
  if (!fourcc(head, 4, "ftyp")) return false;
  const boxSize = be32(head, 0);
  const end = Math.min(boxSize < 16 ? 16 : boxSize, head.length);
  for (let at = 8; at + 4 <= end; at += 4) {
    if (at === 12) continue; // minor version, not a brand
    if (fourcc(head, at, "avif") || fourcc(head, at, "avis")) return true;
  }
  return false;
}

/**
 * Read the intrinsic size from the leading bytes of an image.
 *
 * `contentType` is consulted only to recognise SVG; raster formats are told
 * apart by their signature bytes, because a mislabelled body is exactly the
 * kind of thing this audit exists to report.
 */
export function readImageSize(head: Uint8Array, contentType: string | null): ImageSize {
  if (head.length === 0) return none("empty");
  if (looksLikeSvg(head, contentType)) return none("svg");
  if (hasAt(head, 0, PNG_SIGNATURE)) return readPng(head);
  if (hasAt(head, 0, [0xff, 0xd8])) return readJpeg(head);
  if (fourcc(head, 0, "GIF87a") || fourcc(head, 0, "GIF89a")) return readGif(head);
  if (fourcc(head, 0, "RIFF") && fourcc(head, 8, "WEBP")) return readWebp(head);
  if (isAvif(head)) return readAvif(head);
  return none("unknown-format");
}

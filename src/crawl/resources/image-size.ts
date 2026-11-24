/**
 * Intrinsic image size from the first 64 KiB of a response body, and from up
 * to two further windows of it when a PNG or JPEG header runs past the first
 * (Phase 29d: the answer `need` names the offset, and the state to resume with).
 *
 * Pure: no I/O, no dependencies, and it never decodes a pixel. It reads the
 * width and height a format records in its own header, turned as the file
 * asks to be shown (below), which is what the browser uses as the image's
 * intrinsic size. Written from the format specs (PNG per the W3C spec with its
 * `eXIf` chunk, JPEG per ITU T.81 markers, EXIF's TIFF IFD0 for both
 * orientations, GIF89a, the
 * WebP RIFF container per RFC 9649, and ISOBMFF boxes with the HEIF `ispe`
 * and `irot` properties for AVIF). Nothing is lifted from any library (hard
 * rule 8).
 *
 * THE SIZE IS THE ONE THE BROWSER LAYS OUT, rotation applied (29b final review
 * F3). A file can ask to be shown turned a quarter: a JPEG or a PNG through an
 * EXIF Orientation tag (values 5 to 8 turn it 90 or 270 degrees, with or
 * without a mirror), an AVIF through the HEIF `irot` property (angle 1 or 3).
 * The browser honours that by default (CSS `image-orientation: from-image`),
 * so its
 * `naturalWidth` is the stored height. The width and height returned here are
 * therefore the DISPLAYED ones: the stored pair, swapped when the file asks for
 * a quarter turn. A half turn (orientation 3 or 4, `irot` angle 2) and a mirror
 * alone (2, 4) keep the pair. Without this the stand-in the renderer serves
 * would be laid out on its side, and `images.larger-than-displayed` would
 * report the stored width of a portrait photograph as the width it is shown at.
 *
 *  - JPEG: the first APP1 segment that opens with `Exif\0\0` is read for the
 *    Orientation tag (0x0112) of its IFD0: byte order `II` or `MM`, the TIFF
 *    magic 42, then the IFD's 12-byte entries, every read bounded by the
 *    segment's own end. The tag must be a SHORT with a count of 1 and a value
 *    of 1 to 8. A block that is not that — a malformed or truncated TIFF
 *    header, an IFD offset or entry count running past the segment, an
 *    orientation of the wrong type or out of range — is IGNORED FOR
 *    ORIENTATION and the stored size stands. That is a deliberate fallback,
 *    not a silent one: the SOF size is still read off the file, and an EXIF
 *    block the browser could not read either is one it does not rotate by.
 *    Later Exif APP1 segments are not read. APP1 precedes SOF in the format,
 *    so the block is always inside the bytes a size is read from.
 *  - PNG: the chunks after IHDR are walked up to the first IDAT, and the
 *    first `eXIf` among them is read for the same tag. Its payload is a bare
 *    TIFF header (no `Exif\0\0` prefix), read with the same parser and the
 *    same fallback: a malformed block leaves the IHDR size. Only an `eXIf`
 *    BEFORE IDAT counts — the PNG spec places it there, and Chromium ignores
 *    one after (verified against the pinned Chromium: 40x20 with `eXIf`
 *    orientation 6 before IDAT lays out 20x40, after IDAT 40x20). A walk that
 *    runs past the bytes we hold before IDAT, with no `eXIf` read yet, answers
 *    `need` at the next chunk header's offset: an `eXIf` could still follow, so
 *    the displayed size is unknown until the bytes there are read. A SQUARE PNG
 *    needs no walk at all (turned or not, its sides are the same). Whether the
 *    caller reads on is its business (the resource pass reads at most twice,
 *    ruling R4); a walk it cannot finish is `header-beyond-limit`, never the
 *    IHDR size, which would be a guess about the displayed one.
 *  - WebP: not turned. Chromium does not apply a WebP `EXIF` chunk's
 *    orientation (verified as above), so the VP8/VP8L/VP8X size is what it
 *    lays out.
 *  - AVIF: the `ipco` of `meta/iprp` is walked whole for its first `ispe` and
 *    its first `irot` (angle in the low two bits of its one byte). An `ipco`
 *    that runs past the bytes we hold after its `ispe` is
 *    `header-beyond-limit`, not a size: an `irot` could follow, and a stored
 *    size reported then would be a guess about the displayed one.
 *
 * KNOWN LIMIT (AVIF, 29b final review M6). `ispe` and `irot` are taken as the
 * first of each in `ipco`, without following `ipma` to the primary item. On a
 * single-image AVIF those are the image's. On a GRID or other multi-item AVIF
 * the first `ispe` may be one tile's (or an alpha or thumbnail item's),
 * smaller than the composed image, so the size can be UNDER-reported; for the
 * `ispe` that direction gives a missed `images.larger-than-displayed`, never a
 * false one, since a smaller intrinsic width can only fall under the
 * threshold. The `irot` carries no such guarantee: a first `irot` that belongs
 * to another item would swap (or fail to swap) the primary image's sides, and
 * a wrongly swapped width can fall either side of the threshold. That needs a
 * multi-item AVIF whose items disagree on rotation, which is rare, and is a
 * known limit rather than a handled case.
 *
 * NO GUESSING. A size that cannot be read is `{kind:"none", reason}`, with the
 * reason saying why, never a default dimension. The reasons:
 *   - `empty`               zero bytes;
 *   - `svg`                 a vector format with no intrinsic pixel size;
 *   - `unknown-format`      no known signature (the content type is not trusted
 *                           to name a raster format: bytes decide);
 *   - `header-beyond-limit` the structure is sound so far but runs past the
 *                           bytes we hold before any size appears (an AVIF with
 *                           a big `meta`), or before the rotation is known (an
 *                           AVIF `ipco` cut off after its `ispe`). The parser
 *                           itself never says this for a PNG or JPEG: it
 *                           answers `need`, and the caller ends the walk with
 *                           this reason when it cannot read on;
 *   - `malformed`           the structure is wrong or a dimension is 0.
 *
 * A PNG or JPEG walk that runs out of window answers
 * `{kind:"need", offset, state}`: the file offset to read on from, and what the
 * walk has learnt, to hand back with the bytes found there.
 *
 * Every read is bounds-checked against `head.length`, and the function never
 * throws on any input: a fuzz test pins that.
 */

/** How many leading bytes of an image the resource pass keeps for this parser. */
export const IMAGE_HEADER_BYTES = 65_536;

/**
 * Where a PNG or JPEG walk stands when its window runs out, so a read of the
 * bytes at `at` can carry it on. Only what the walk has learnt is kept: a PNG's
 * stored IHDR size and the EXIF orientation found so far (`undefined` before
 * any, `null` when one was found and could not be read); a JPEG's orientation.
 * `at` is the absolute offset the next window must start at, the same number
 * the `need` answer carries.
 */
export type ImageWalkState =
  | { format: "png"; at: number; width: number; height: number; orientation: number | null | undefined }
  | { format: "jpeg"; at: number; orientation: number | null | undefined };

/**
 * What a read of the head says: a size, a reason none can be had, or `need`,
 * the walk is sound so far and goes on at byte `offset` of the file (hand the
 * bytes there to `parseImageHead` with `state`).
 */
export type ImageParse =
  | { kind: "size"; format: "png" | "jpeg" | "gif" | "webp" | "avif"; width: number; height: number }
  | { kind: "reason"; reason: "svg" | "unknown-format" | "header-beyond-limit" | "malformed" | "empty" }
  | { kind: "need"; offset: number; state: ImageWalkState };

type NoneReason = Extract<ImageParse, { kind: "reason" }>["reason"];
type Format = Extract<ImageParse, { kind: "size" }>["format"];

const none = (reason: NoneReason): ImageParse => ({ kind: "reason", reason });

/**
 * The largest dimension kept: 2^31-1, the PNG spec's own ceiling and the top of
 * the `resources.width`/`height` integer columns. A header can say more (PNG
 * IHDR and AVIF `ispe` are u32 on the wire); a hostile value is malformed here
 * rather than a write that throws and ends the pass.
 */
export const MAX_IMAGE_DIMENSION = 2_147_483_647;

/** A found size, or malformed when either dimension is 0 or past the ceiling. */
function size(format: Format, width: number, height: number): ImageParse {
  if (width <= 0 || height <= 0) return none("malformed");
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) return none("malformed");
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

/** IHDR's data length: the spec fixes it at 13. */
const PNG_IHDR_LENGTH = 13;
/** The PNG spec's ceiling on a chunk's data length. */
const PNG_MAX_CHUNK = 0x7fffffff;

function readPng(head: Uint8Array, resume?: Extract<ImageWalkState, { format: "png" }>): ImageParse {
  let width: number;
  let height: number;
  let orientation: number | null | undefined;
  // `base` is the file offset of head[0]; `pos` indexes `head`.
  let base: number;
  let pos: number;
  if (resume === undefined) {
    // Signature (8), IHDR length (4), "IHDR" (4), width (4), height (4).
    if (head.length < 24 || !fourcc(head, 12, "IHDR")) return none("malformed");
    if (be32(head, 8) !== PNG_IHDR_LENGTH) return none("malformed");
    width = be32(head, 16);
    height = be32(head, 20);
    // A square image has the same sides turned or not: no chunk can change the
    // size, so there is nothing to walk for (and nothing to read past 64 KiB).
    if (width === height) return size("png", width, height);
    orientation = undefined;
    base = 0;
    pos = 8 + 12 + PNG_IHDR_LENGTH;
  } else {
    ({ width, height, orientation } = resume);
    base = resume.at;
    pos = 0;
  }
  // Ask for the bytes at window index `at` (a chunk header) and carry on there.
  const need = (at: number): ImageParse => ({
    kind: "need",
    offset: base + at,
    state: { format: "png", at: base + at, width, height, orientation },
  });
  // The chunks between IHDR and the first IDAT, for an `eXIf` (module
  // header). Each: length (4), type (4), data, CRC (4).
  for (;;) {
    if (pos + 8 > head.length) {
      // Past our bytes before IDAT: an `eXIf` already read decides; without
      // one, a later chunk could still be one, and the size is unknown until
      // the bytes there are read.
      if (orientation === undefined) return need(pos);
      break;
    }
    const length = be32(head, pos);
    if (length > PNG_MAX_CHUNK) return none("malformed");
    if (fourcc(head, pos + 4, "IDAT")) break;
    // IEND before any image data: no image to size.
    if (fourcc(head, pos + 4, "IEND")) return none("malformed");
    const data = pos + 8;
    const end = data + length;
    if (orientation === undefined && fourcc(head, pos + 4, "eXIf")) {
      // A truncated `eXIf` cannot be read: read it whole from its header.
      if (end > head.length) return need(pos);
      orientation = tiffOrientation(head, data, end);
    }
    pos = end + 4;
  }
  return quarterTurned(orientation ?? null) ? size("png", height, width) : size("png", width, height);
}

function readGif(head: Uint8Array): ImageParse {
  // "GIF8?a" (6), then the logical screen width and height, little-endian.
  if (head.length < 10) return none("malformed");
  return size("gif", le16(head, 6), le16(head, 8));
}

/** SOF0-SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** The EXIF Orientation tag, a TIFF SHORT, in IFD0. */
const EXIF_ORIENTATION_TAG = 0x0112;
const TIFF_SHORT = 3;
/** `Exif` and two zero bytes: the APP1 payload signature of an EXIF block. */
const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/**
 * The EXIF Orientation (1 to 8) of the APP1 payload in `[start, end)`, or null
 * when the payload is not an EXIF block or its orientation cannot be read —
 * which leaves the stored size standing (module header).
 */
function exifOrientation(head: Uint8Array, start: number, end: number): number | null {
  if (start + EXIF_SIGNATURE.length > end || !hasAt(head, start, EXIF_SIGNATURE)) return null;
  return tiffOrientation(head, start + EXIF_SIGNATURE.length, end);
}

/**
 * The Orientation (1 to 8) in IFD0 of the TIFF header at `tiff`, inside
 * `[tiff, end)`, or null when it cannot be read. A JPEG's APP1 carries this
 * after `Exif\0\0`; a PNG `eXIf` chunk is this alone. Every read is checked
 * against `end`, which the caller has checked against `head.length`; nothing
 * here throws.
 */
function tiffOrientation(head: Uint8Array, tiff: number, end: number): number | null {
  // Byte order (2), the magic 42 (2), the IFD0 offset from the TIFF start (4).
  if (tiff + 8 > end) return null;
  let little: boolean;
  if (head[tiff] === 0x49 && head[tiff + 1] === 0x49) little = true;
  else if (head[tiff] === 0x4d && head[tiff + 1] === 0x4d) little = false;
  else return null;
  const r16 = (o: number): number => (little ? le16(head, o) : be16(head, o));
  const r32 = (o: number): number => (little ? le32(head, o) : be32(head, o));
  if (r16(tiff + 2) !== 42) return null;
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = r16(ifd);
  // The whole IFD must lie in the segment: an entry count that runs past it is
  // a malformed block, even when the entry wanted happens to come first.
  if (ifd + 2 + count * 12 > end) return null;
  for (let i = 0; i < count; i++) {
    // Each entry: tag (2), type (2), count (4), value or offset (4).
    const entry = ifd + 2 + i * 12;
    if (r16(entry) !== EXIF_ORIENTATION_TAG) continue;
    if (r16(entry + 2) !== TIFF_SHORT || r32(entry + 4) !== 1) return null;
    // A SHORT sits left-justified in the value field, in the block's order.
    const value = r16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/** Orientations 5 to 8 turn the image a quarter, so its sides swap. */
const quarterTurned = (orientation: number | null): boolean => orientation !== null && orientation >= 5;

function readJpeg(head: Uint8Array, resume?: Extract<ImageWalkState, { format: "jpeg" }>): ImageParse {
  // `base` is the file offset of head[0]; `pos` indexes `head`.
  const base = resume === undefined ? 0 : resume.at;
  let pos = resume === undefined ? 2 : 0; // past SOI on a first read
  // `undefined` until the first Exif APP1 is read; null when it had none we could read.
  let orientation: number | null | undefined = resume?.orientation;
  // Ask for the bytes at window index `at` (a marker) and carry on there.
  const need = (at: number): ImageParse => ({
    kind: "need",
    offset: base + at,
    state: { format: "jpeg", at: base + at, orientation },
  });
  for (;;) {
    const markerStart = pos;
    // Find the next marker: 0xFF, then any number of 0xFF fill bytes.
    while (pos < head.length && head[pos] !== 0xff) pos++;
    while (pos < head.length && head[pos] === 0xff) pos++;
    if (pos >= head.length) {
      // No marker yet. Bytes already scanned held none; a trailing 0xFF may
      // start one, so the next window begins on it.
      return need(head.length > markerStart && head[head.length - 1] === 0xff ? head.length - 1 : head.length);
    }
    const marker = head[pos]!;
    pos++;
    if (marker === 0x00) continue; // a stuffed zero, not a marker
    // Standalone markers carry no length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // EOI or SOS before any SOF: the frame header never came.
    if (marker === 0xd9 || marker === 0xda) return none("malformed");
    // `pos - 2` is the 0xFF in front of the marker byte.
    if (pos + 2 > head.length) return need(pos - 2);
    const length = be16(head, pos);
    if (length < 2) return none("malformed");
    if (isSof(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (length < 7) return none("malformed");
      if (pos + 7 > head.length) return need(pos - 2);
      const width = be16(head, pos + 5);
      const height = be16(head, pos + 3);
      return quarterTurned(orientation ?? null) ? size("jpeg", height, width) : size("jpeg", width, height);
    }
    // APP1 that is, or may be (its signature is cut off), the first Exif block.
    const exifWanted =
      marker === 0xe1 &&
      orientation === undefined &&
      (pos + 2 + EXIF_SIGNATURE.length > head.length || hasAt(head, pos + 2, EXIF_SIGNATURE));
    if (pos + length > head.length) {
      // The segment runs past the window: an Exif one is read whole from its
      // marker, any other is skipped to the marker after it.
      return exifWanted ? need(pos - 2) : need(pos + length);
    }
    if (exifWanted) orientation = exifOrientation(head, pos + 2, pos + length);
    pos += length;
  }
}

function readWebp(head: Uint8Array): ImageParse {
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
 * The size an `ipco` whose children lie in `[from, to)` gives: its first `ispe`,
 * swapped when its first `irot` turns the image a quarter (module header). The
 * whole box is walked, because `irot` usually follows `ispe`. Null when the
 * `ipco` holds no `ispe` at all.
 */
function readIpco(head: Uint8Array, from: number, to: number): ImageParse | null {
  let stored: { width: number; height: number } | null = null;
  let angle: number | null = null;
  let pos = from;
  while (pos < to) {
    const b = boxAt(head, pos, Math.min(to, head.length));
    // A header that does not fit: past our bytes we cannot tell, but inside
    // them it overruns its `ipco`.
    if (b === "beyond") return none(to > head.length ? "header-beyond-limit" : "malformed");
    if (b === "bad") return none("malformed");
    // A property that claims to run past its `ipco`'s declared end contradicts
    // its parent, whether or not we hold the bytes.
    if (b.end > to) return none("malformed");
    if (b.type === "ispe" && stored === null) {
      // ispe is a full box: version/flags (4), then width (4) and height (4),
      // inside the box's own end first, then inside our bytes.
      if (b.body + 12 > b.end) return none("malformed");
      if (b.body + 12 > head.length) return none("header-beyond-limit");
      stored = { width: be32(head, b.body + 4), height: be32(head, b.body + 8) };
    } else if (b.type === "irot" && angle === null) {
      // irot: one byte, six reserved bits and the angle in quarter turns.
      if (b.body + 1 > b.end) return none("malformed");
      if (b.body + 1 > head.length) return none("header-beyond-limit");
      angle = u8(head, b.body) & 0x03;
    }
    if (stored !== null && angle !== null) break;
    pos = b.end;
  }
  if (stored === null) return null;
  return angle === 1 || angle === 3
    ? size("avif", stored.height, stored.width)
    : size("avif", stored.width, stored.height);
}

/**
 * Walk the children in `[from, to)` for the first box of `path[0]`, descending
 * through `path` to the `ipco`, then read it (`readIpco`). Returns the size,
 * or the reason none was found.
 */
function findIpcoSize(head: Uint8Array, from: number, to: number, path: readonly string[]): ImageParse | null {
  const want = path[0]!;
  let pos = from;
  while (pos < to) {
    const b = boxAt(head, pos, Math.min(to, head.length));
    if (b === "beyond") return none("header-beyond-limit");
    if (b === "bad") return none("malformed");
    if (b.type === want) {
      // `meta` is a full box (4 bytes of version/flags before its children).
      const childrenAt = want === "meta" ? b.body + 4 : b.body;
      const found =
        path.length === 1
          ? readIpco(head, childrenAt, b.end)
          : findIpcoSize(head, childrenAt, Math.min(b.end, head.length), path.slice(1));
      if (found !== null) {
        // A container that ended in bounds without the target is malformed, but
        // one that ran past our bytes is beyond the limit: the walk says which.
        return found;
      }
    }
    if (b.end > head.length && b.end > to) return none("header-beyond-limit");
    pos = b.end;
  }
  return null;
}

function readAvif(head: Uint8Array): ImageParse {
  const ftyp = boxAt(head, 0, head.length);
  if (ftyp === "beyond") return none("header-beyond-limit");
  if (ftyp === "bad" || ftyp.type !== "ftyp") return none("malformed");
  const result = findIpcoSize(head, 0, head.length, ["meta", "iprp", "ipco"]);
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
 * Read the intrinsic size from the leading bytes of an image, or carry on a
 * walk a previous read left.
 *
 * `contentType` is consulted only to recognise SVG; raster formats are told
 * apart by their signature bytes, because a mislabelled body is exactly the
 * kind of thing this audit exists to report.
 *
 * With `state` (from an earlier `need`), `head` is the window of the file that
 * starts at `state.at`, not the start of it: there is no signature to find and
 * the walk resumes where it stopped.
 */
export function parseImageHead(head: Uint8Array, contentType: string | null, state?: ImageWalkState): ImageParse {
  if (state !== undefined) return state.format === "png" ? readPng(head, state) : readJpeg(head, state);
  if (head.length === 0) return none("empty");
  if (looksLikeSvg(head, contentType)) return none("svg");
  if (hasAt(head, 0, PNG_SIGNATURE)) return readPng(head);
  if (hasAt(head, 0, [0xff, 0xd8])) return readJpeg(head);
  if (fourcc(head, 0, "GIF87a") || fourcc(head, 0, "GIF89a")) return readGif(head);
  if (fourcc(head, 0, "RIFF") && fourcc(head, 8, "WEBP")) return readWebp(head);
  if (isAvif(head)) return readAvif(head);
  return none("unknown-format");
}

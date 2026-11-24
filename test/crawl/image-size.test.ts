/**
 * The image header parser: intrinsic width/height from the first 64 KiB.
 *
 * Every header here is built by hand from the format specs (PNG, JPEG T.81
 * markers, GIF89a, WebP RIFF container, ISOBMFF/HEIF `ispe`), so each exact
 * dimension is derived from the bytes written below and not from a library.
 */
import { describe, expect, it } from "vitest";
import { IMAGE_HEADER_BYTES, parseImageHead } from "../../src/crawl/resources/image-size.js";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** One PNG chunk: length, type, data, and a CRC the reader does not check (zeros). */
const pngChunk = (type: string, data: number[]): number[] => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const IHDR = (w: number, h: number): number[] => pngChunk("IHDR", [...be32(w), ...be32(h), 8, 2, 0, 0, 0]);
/** The start of an IDAT: the reader stops at its type, so no image data follows. */
const IDAT_START = [...be32(10), ...ascii("IDAT")];
const png = (w: number, h: number, ...beforeIdat: number[][]): Uint8Array =>
  bytes(PNG_SIG, IHDR(w, h), ...beforeIdat, IDAT_START);

const jpegSof = (marker: number, w: number, h: number): number[] => [
  0xff, marker, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
];
const jpegApp1 = (payload: number): number[] => [0xff, 0xe1, ...be16(payload + 2), ...new Array<number>(payload).fill(0)];

const box = (type: string, ...body: number[][]): number[] => {
  const content = body.flat();
  return [...be32(8 + content.length), ...ascii(type), ...content];
};
const avif = (w: number, h: number): Uint8Array =>
  bytes(
    box("ftyp", ascii("avif"), be32(0), ascii("avif"), ascii("mif1")),
    box(
      "meta",
      [0, 0, 0, 0],
      box("hdlr", [0, 0, 0, 0], be32(0), ascii("pict"), new Array<number>(12).fill(0), [0]),
      box("iprp", box("ipco", box("colr", ascii("nclx"), [0, 0, 0, 0, 0]), box("ispe", [0, 0, 0, 0], be32(w), be32(h)))),
    ),
  );

/**
 * An APP1 Exif segment whose IFD0 holds `entries` (tag, type, count, value),
 * written in the byte order `order` names. A SHORT value sits left-justified
 * in the 4-byte value field, in that byte order (TIFF 6.0 §2).
 */
const exifApp1 = (order: "II" | "MM", entries: Array<[tag: number, type: number, count: number, value: number]>): number[] => {
  const w16 = order === "II" ? le16 : be16;
  const w32 = order === "II" ? le32 : be32;
  const tiff = [
    ...ascii(order),
    ...w16(42),
    ...w32(8), // IFD0 right after the 8-byte TIFF header
    ...w16(entries.length),
    ...entries.flatMap(([tag, type, count, value]) => [...w16(tag), ...w16(type), ...w32(count), ...w16(value), 0, 0]),
    ...w32(0), // no IFD1
  ];
  const payload = [...ascii("Exif"), 0, 0, ...tiff];
  return [0xff, 0xe1, ...be16(payload.length + 2), ...payload];
};
const ORIENTATION = 0x0112;
const SHORT = 3;
const orientedJpeg = (order: "II" | "MM", orientation: number, w = 4000, h = 3000): Uint8Array =>
  bytes([0xff, 0xd8], exifApp1(order, [[ORIENTATION, SHORT, 1, orientation]]), jpegSof(0xc0, w, h), [0xff, 0xda]);

const irot = (angle: number): number[] => box("irot", [angle]);
const rotatedAvif = (w: number, h: number, ...extra: number[][]): Uint8Array =>
  bytes(
    box("ftyp", ascii("avif"), be32(0), ascii("avif"), ascii("mif1")),
    box(
      "meta",
      [0, 0, 0, 0],
      box("iprp", box("ipco", box("ispe", [0, 0, 0, 0], be32(w), be32(h)), ...extra)),
    ),
  );

describe("parseImageHead: the size the browser lays out, rotation applied (29b final review F3)", () => {
  it("a JPEG whose EXIF orientation is 6 is its stored size turned, in either byte order", () => {
    for (const order of ["II", "MM"] as const) {
      expect(parseImageHead(orientedJpeg(order, 6), "image/jpeg"), order).toEqual({ kind: "size", format: "jpeg", width: 3000, height: 4000 });
    }
  });

  it("orientations 5, 7 and 8 turn it too; 1 to 4 do not", () => {
    for (const o of [5, 6, 7, 8]) {
      expect(parseImageHead(orientedJpeg("MM", o), null), String(o)).toMatchObject({ width: 3000, height: 4000 });
    }
    for (const o of [1, 2, 3, 4]) {
      expect(parseImageHead(orientedJpeg("II", o), null), String(o)).toMatchObject({ width: 4000, height: 3000 });
    }
  });

  it("finds the orientation among other IFD0 entries", () => {
    const head = bytes(
      [0xff, 0xd8],
      exifApp1("II", [[0x010f, 2, 4, 0], [0x0110, 2, 4, 0], [ORIENTATION, SHORT, 1, 8], [0x011a, 5, 1, 0]]),
      jpegSof(0xc2, 640, 480),
    );
    expect(parseImageHead(head, "image/jpeg")).toEqual({ kind: "size", format: "jpeg", width: 480, height: 640 });
  });

  it("an APP1 that is not Exif (XMP) leaves the stored size alone", () => {
    const xmp = [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta/>")];
    const head = bytes([0xff, 0xd8], [0xff, 0xe1, ...be16(xmp.length + 2), ...xmp], jpegSof(0xc0, 4000, 3000));
    expect(parseImageHead(head, null)).toMatchObject({ width: 4000, height: 3000 });
  });

  it("a malformed EXIF block is ignored for orientation, never thrown on: the stored size stands", () => {
    const stored = { kind: "size", format: "jpeg", width: 4000, height: 3000 };
    const app1 = (payload: number[]): number[] => [0xff, 0xe1, ...be16(payload.length + 2), ...payload];
    const exif = (...tiff: number[]): number[] => app1([...ascii("Exif"), 0, 0, ...tiff]);
    const cases: Record<string, number[]> = {
      "an unknown byte order": exif(...ascii("XX"), ...be16(42), ...be32(8), ...be16(1), ...be16(ORIENTATION), ...be16(SHORT), ...be32(1), 0, 6, 0, 0),
      "a wrong TIFF magic": exif(...ascii("MM"), ...be16(43), ...be32(8), ...be16(1), ...be16(ORIENTATION), ...be16(SHORT), ...be32(1), 0, 6, 0, 0),
      "an IFD0 offset past the segment": exif(...ascii("MM"), ...be16(42), ...be32(0xfffffff0)),
      "an entry count running past the segment": exif(...ascii("II"), ...le16(42), ...le32(8), ...le16(500), ...le16(ORIENTATION), ...le16(SHORT), ...le32(1), 6, 0, 0, 0),
      "a TIFF header cut short": exif(...ascii("MM"), 0),
      "only the Exif signature": app1([...ascii("Exif"), 0, 0]),
      "an orientation of the wrong type": exifApp1("MM", [[ORIENTATION, 4, 1, 6]]),
      "an orientation with a count of two": exifApp1("MM", [[ORIENTATION, SHORT, 2, 6]]),
      "an orientation of 0": exifApp1("MM", [[ORIENTATION, SHORT, 1, 0]]),
      "an orientation of 9": exifApp1("II", [[ORIENTATION, SHORT, 1, 9]]),
    };
    for (const [name, segment] of Object.entries(cases)) {
      const head = bytes([0xff, 0xd8], segment, jpegSof(0xc0, 4000, 3000));
      expect(parseImageHead(head, "image/jpeg"), name).toEqual(stored);
    }
  });

  it("an AVIF whose irot angle is 1 or 3 is its ispe turned; 0 and 2 are not", () => {
    expect(parseImageHead(rotatedAvif(1920, 1080, irot(1)), "image/avif")).toEqual({ kind: "size", format: "avif", width: 1080, height: 1920 });
    expect(parseImageHead(rotatedAvif(1920, 1080, irot(3)), "image/avif")).toMatchObject({ width: 1080, height: 1920 });
    expect(parseImageHead(rotatedAvif(1920, 1080, irot(2)), "image/avif")).toMatchObject({ width: 1920, height: 1080 });
    expect(parseImageHead(rotatedAvif(1920, 1080, irot(0)), "image/avif")).toMatchObject({ width: 1920, height: 1080 });
    // The six reserved bits above the angle are not part of it.
    expect(parseImageHead(rotatedAvif(1920, 1080, irot(0xfc | 1)), "image/avif")).toMatchObject({ width: 1080, height: 1920 });
  });

  it("an irot before the ispe counts the same", () => {
    const head = bytes(
      box("ftyp", ascii("avif"), be32(0), ascii("avif")),
      box("meta", [0, 0, 0, 0], box("iprp", box("ipco", irot(1), box("ispe", [0, 0, 0, 0], be32(300), be32(200))))),
    );
    expect(parseImageHead(head, "image/avif")).toMatchObject({ width: 200, height: 300 });
  });

  it("an AVIF whose ipco is cut off after its ispe is header-beyond-limit: an irot may follow", () => {
    const full = rotatedAvif(1920, 1080, box("colr", ascii("nclx"), [0, 0, 0, 0, 0]), irot(1));
    expect(parseImageHead(full.subarray(0, full.length - 4), "image/avif")).toEqual({ kind: "reason", reason: "header-beyond-limit" });
  });
});

/** A bare TIFF header with IFD0 holding one Orientation entry: a PNG `eXIf` payload. */
const tiffOrientation = (order: "II" | "MM", orientation: number): number[] => {
  const w16 = order === "II" ? le16 : be16;
  const w32 = order === "II" ? le32 : be32;
  return [...ascii(order), ...w16(42), ...w32(8), ...w16(1), ...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0, ...w32(0)];
};

describe("parseImageHead: a PNG eXIf before IDAT turns the size (29b re-review)", () => {
  it("an eXIf orientation of 6 before IDAT swaps the sides, in either byte order", () => {
    for (const order of ["II", "MM"] as const) {
      expect(parseImageHead(png(40, 20, pngChunk("eXIf", tiffOrientation(order, 6))), "image/png"), order).toEqual({
        kind: "size",
        format: "png",
        width: 20,
        height: 40,
      });
    }
  });

  it("orientation 8 swaps, 3 does not, and an eXIf behind other chunks still counts", () => {
    const text = pngChunk("tEXt", ascii("Comment\0made by hand"));
    expect(parseImageHead(png(40, 20, text, pngChunk("eXIf", tiffOrientation("MM", 8))), null)).toMatchObject({ width: 20, height: 40 });
    expect(parseImageHead(png(40, 20, pngChunk("eXIf", tiffOrientation("MM", 3))), null)).toMatchObject({ width: 40, height: 20 });
  });

  it("an eXIf after IDAT is not read: the browser ignores it", () => {
    const head = bytes(PNG_SIG, IHDR(40, 20), pngChunk("IDAT", [0, 0]), pngChunk("eXIf", tiffOrientation("MM", 6)));
    expect(parseImageHead(head, "image/png")).toEqual({ kind: "size", format: "png", width: 40, height: 20 });
  });

  it("a malformed eXIf falls back to the IHDR size and never throws", () => {
    const bad: Record<string, number[]> = {
      "an unknown byte order": [...ascii("XX"), ...tiffOrientation("MM", 6).slice(2)],
      "an Exif prefix (a JPEG payload, not a PNG one)": [...ascii("Exif"), 0, 0, ...tiffOrientation("MM", 6)],
      "a TIFF header cut short": [...ascii("MM"), 0],
      "an empty chunk": [],
      "an orientation of 9": tiffOrientation("II", 9),
    };
    for (const [name, payload] of Object.entries(bad)) {
      expect(parseImageHead(png(40, 20, pngChunk("eXIf", payload)), "image/png"), name).toEqual({ kind: "size", format: "png", width: 40, height: 20 });
    }
  });

  it("chunks running past the window before IDAT ask for the next chunk header: an eXIf could follow", () => {
    const full = png(40, 20, pngChunk("iCCP", new Array<number>(70_000).fill(0x41)), pngChunk("eXIf", tiffOrientation("MM", 6)));
    const need = parseImageHead(full.subarray(0, IMAGE_HEADER_BYTES), "image/png");
    // 33 (signature + IHDR) + 8 (iCCP header) + 70,000 data + 4 CRC.
    expect(need).toMatchObject({ kind: "need", offset: 33 + 8 + 70_000 + 4 });
    if (need.kind !== "need") throw new Error("expected need");
    // Fed the window that starts there, the eXIf turns it.
    const resumed = parseImageHead(full.subarray(need.offset, need.offset + IMAGE_HEADER_BYTES), "image/png", need.state);
    expect(resumed).toEqual({ kind: "size", format: "png", width: 20, height: 40 });
    // Once the eXIf is read, a cut-off before IDAT changes nothing.
    const read = png(40, 20, pngChunk("eXIf", tiffOrientation("MM", 6)), pngChunk("iTXt", new Array<number>(70_000).fill(0x41)));
    expect(parseImageHead(read.subarray(0, IMAGE_HEADER_BYTES), "image/png")).toMatchObject({ width: 20, height: 40 });
    // A truncated eXIf cannot be read.
    const cut = png(40, 20, pngChunk("eXIf", tiffOrientation("MM", 6)));
    expect(parseImageHead(cut.subarray(0, 33 + 8 + 10), "image/png")).toMatchObject({ kind: "need", offset: 33 });
  });

  it("IEND before any IDAT, a bad IHDR length or a chunk length past the spec's ceiling is malformed", () => {
    expect(parseImageHead(bytes(PNG_SIG, IHDR(40, 20), pngChunk("IEND", [])), null)).toEqual({ kind: "reason", reason: "malformed" });
    const longIhdr = bytes(PNG_SIG, be32(14), ascii("IHDR"), be32(40), be32(20), [8, 2, 0, 0, 0, 0], [0, 0, 0, 0], IDAT_START);
    expect(parseImageHead(longIhdr, null)).toEqual({ kind: "reason", reason: "malformed" });
    expect(parseImageHead(bytes(PNG_SIG, IHDR(40, 20), be32(0x80000000), ascii("tEXt")), null)).toEqual({ kind: "reason", reason: "malformed" });
  });
});

describe("parseImageHead: AVIF boxes are bounded by their own end (29b re-review)", () => {
  const avifWith = (...ipco: number[][]): Uint8Array =>
    bytes(box("ftyp", ascii("avif"), be32(0), ascii("avif")), box("meta", [0, 0, 0, 0], box("iprp", box("ipco", ...ipco))));
  const ispe = box("ispe", [0, 0, 0, 0], be32(300), be32(200));

  it("an empty irot or a short ispe is malformed, not read from the next box", () => {
    expect(parseImageHead(avifWith(ispe, box("irot")), "image/avif")).toEqual({ kind: "reason", reason: "malformed" });
    expect(parseImageHead(avifWith(box("ispe", [0, 0, 0, 0], be32(300)), irot(1)), "image/avif")).toEqual({ kind: "reason", reason: "malformed" });
  });

  it("a child box running past its ipco's declared end is malformed", () => {
    // An ipco declaring 8 bytes fewer than the ispe it holds needs.
    const ispeBytes = box("ispe", [0, 0, 0, 0], be32(300), be32(200));
    const ipco = [...be32(8 + ispeBytes.length - 8), ...ascii("ipco"), ...ispeBytes];
    const head = bytes(box("ftyp", ascii("avif"), be32(0), ascii("avif")), box("meta", [0, 0, 0, 0], box("iprp", ipco)));
    expect(parseImageHead(head, "image/avif")).toEqual({ kind: "reason", reason: "malformed" });
    // The same contradiction in a file cut off inside its ipco: the child's
    // header is held, and its declared end already passes the ipco's.
    const cut = bytes(
      box("ftyp", ascii("avif"), be32(0), ascii("avif")),
      [...be32(1000), ...ascii("meta"), 0, 0, 0, 0],
      [...be32(900), ...ascii("iprp")],
      [...be32(108), ...ascii("ipco")],
      [...be32(200), ...ascii("free"), 0, 0, 0, 0],
    );
    expect(parseImageHead(cut, "image/avif")).toEqual({ kind: "reason", reason: "malformed" });
  });
});

describe("parseImageHead: a dimension past int4 is malformed, never a size", () => {
  it("an AVIF ispe of 0xFFFFFFFF", () => {
    expect(parseImageHead(avif(0xffffffff, 100), "image/avif")).toEqual({ kind: "reason", reason: "malformed" });
    expect(parseImageHead(avif(100, 0xffffffff), "image/avif")).toEqual({ kind: "reason", reason: "malformed" });
  });
  it("a PNG with width 0x80000000, and height 0xFFFFFFFF", () => {
    expect(parseImageHead(png(0x80000000, 10), "image/png")).toEqual({ kind: "reason", reason: "malformed" });
    expect(parseImageHead(png(10, 0xffffffff), "image/png")).toEqual({ kind: "reason", reason: "malformed" });
  });
  it("2^31-1 itself is still a size", () => {
    expect(parseImageHead(png(0x7fffffff, 1), "image/png")).toEqual({ kind: "size", format: "png", width: 2147483647, height: 1 });
  });
});

describe("parseImageHead: one per format", () => {
  it("PNG 1600x1200", () => {
    expect(parseImageHead(png(1600, 1200), "image/png")).toEqual({ kind: "size", format: "png", width: 1600, height: 1200 });
  });

  it("JPEG with an APP1 segment before SOF2, 800x533", () => {
    const head = bytes([0xff, 0xd8], jpegApp1(300), jpegSof(0xc2, 800, 533), [0xff, 0xda]);
    expect(parseImageHead(head, "image/jpeg")).toEqual({ kind: "size", format: "jpeg", width: 800, height: 533 });
  });

  it("GIF 1x1", () => {
    const head = bytes(ascii("GIF89a"), le16(1), le16(1), [0, 0, 0]);
    expect(parseImageHead(head, "image/gif")).toEqual({ kind: "size", format: "gif", width: 1, height: 1 });
  });

  it("WebP VP8 640x480", () => {
    const head = bytes(ascii("RIFF"), le32(30), ascii("WEBP"), ascii("VP8 "), le32(18), [0, 0, 0], [0x9d, 0x01, 0x2a], le16(640), le16(480), [0, 0, 0, 0]);
    expect(parseImageHead(head, "image/webp")).toEqual({ kind: "size", format: "webp", width: 640, height: 480 });
  });

  it("WebP VP8L 641x481", () => {
    const packed = ((641 - 1) | ((481 - 1) << 14)) >>> 0;
    const head = bytes(ascii("RIFF"), le32(30), ascii("WEBP"), ascii("VP8L"), le32(10), [0x2f], le32(packed), [0, 0, 0, 0, 0]);
    expect(parseImageHead(head, "image/webp")).toEqual({ kind: "size", format: "webp", width: 641, height: 481 });
  });

  it("WebP VP8X 4000x3000", () => {
    const head = bytes(ascii("RIFF"), le32(30), ascii("WEBP"), ascii("VP8X"), le32(10), [0, 0, 0, 0], le24(3999), le24(2999));
    expect(parseImageHead(head, "image/webp")).toEqual({ kind: "size", format: "webp", width: 4000, height: 3000 });
  });

  it("AVIF ispe 1920x1080", () => {
    expect(parseImageHead(avif(1920, 1080), "image/avif")).toEqual({ kind: "size", format: "avif", width: 1920, height: 1080 });
  });
});

describe("parseImageHead: nothing is guessed", () => {
  it("SVG by content type", () => {
    const svg = bytes(ascii('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'));
    expect(parseImageHead(svg, "image/svg+xml")).toEqual({ kind: "reason", reason: "svg" });
  });

  it("SVG by a leading <svg or <?xml with no useful content type", () => {
    expect(parseImageHead(bytes(ascii("  <svg/>")), null)).toEqual({ kind: "reason", reason: "svg" });
    expect(parseImageHead(bytes(ascii('<?xml version="1.0"?><svg/>')), "application/octet-stream")).toEqual({ kind: "reason", reason: "svg" });
  });

  it("2 KB of 0x41 under image/png is unknown-format", () => {
    expect(parseImageHead(new Uint8Array(2048).fill(0x41), "image/png")).toEqual({ kind: "reason", reason: "unknown-format" });
  });

  it("a JPEG window ending on junk where a marker belonged is header-beyond-limit, not a need", () => {
    const head = bytes([0xff, 0xd8], new Array<number>(IMAGE_HEADER_BYTES - 2).fill(0));
    expect(parseImageHead(head, "image/jpeg")).toEqual({ kind: "reason", reason: "header-beyond-limit" });
  });

  it("a JPEG window whose last segment ends exactly at its end, or that ends on fill bytes, asks to go on", () => {
    const seg = (n: number): number[] => [0xff, 0xe2, ...be16(n + 2), ...new Array<number>(n).fill(0)];
    const exact = bytes([0xff, 0xd8], seg(IMAGE_HEADER_BYTES - 2 - 4));
    expect(exact.length).toBe(IMAGE_HEADER_BYTES);
    expect(parseImageHead(exact, "image/jpeg")).toMatchObject({ kind: "need", offset: IMAGE_HEADER_BYTES });
    const fill = bytes([0xff, 0xd8], seg(IMAGE_HEADER_BYTES - 2 - 4 - 3), [0xff, 0xff, 0xff]);
    expect(fill.length).toBe(IMAGE_HEADER_BYTES);
    expect(parseImageHead(fill, "image/jpeg")).toMatchObject({ kind: "need", offset: IMAGE_HEADER_BYTES - 1 });
  });

  it("an AVIF whose meta box is cut off before ispe is header-beyond-limit", () => {
    const full = avif(1920, 1080);
    expect(parseImageHead(full.subarray(0, full.length - 20), "image/avif")).toEqual({ kind: "reason", reason: "header-beyond-limit" });
  });

  it("PNG with width 0 is malformed", () => {
    expect(parseImageHead(png(0, 10), "image/png")).toEqual({ kind: "reason", reason: "malformed" });
  });

  it("a JPEG SOF excludes DHT/JPG/DAC markers", () => {
    const head = bytes([0xff, 0xd8], [0xff, 0xc4, ...be16(4), 0, 0], jpegSof(0xc1, 20, 10));
    expect(parseImageHead(head, null)).toEqual({ kind: "size", format: "jpeg", width: 20, height: 10 });
  });

  it("an empty array is empty", () => {
    expect(parseImageHead(new Uint8Array(0), "image/png")).toEqual({ kind: "reason", reason: "empty" });
  });
});

describe("parseImageHead: never throws", () => {
  it("8000 random buffers behind real signatures always return a kind", () => {
    const sigs: number[][] = [
      PNG_SIG,
      [0xff, 0xd8, 0xff],
      ascii("GIF89a"),
      [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")],
      [0, 0, 0, 24, ...ascii("ftyp"), ...ascii("avif")],
      // F3: the EXIF reader runs on every APP1 that opens with the Exif
      // signature, in both byte orders, so random bytes reach every read in it.
      [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x80, ...ascii("Exif"), 0, 0, ...ascii("II"), 42, 0],
      [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x80, ...ascii("Exif"), 0, 0, ...ascii("MM"), 0, 42],
      // PNG (29b re-review): an eXIf before IDAT, both byte orders, so random
      // bytes reach the chunk walk and the bare-TIFF reader.
      [...PNG_SIG, ...IHDR(40, 20), 0, 0, 0, 0x60, ...ascii("eXIf"), ...ascii("II"), 42, 0],
      [...PNG_SIG, ...IHDR(40, 20), 0, 0, 0, 0x60, ...ascii("eXIf"), ...ascii("MM"), 0, 42],
      // ...and the ipco walk that reads irot beside ispe.
      [0, 0, 0, 16, ...ascii("ftyp"), ...ascii("avif"), 0, 0, 0, 0, 0, 0, 0, 0x80, ...ascii("meta"), 0, 0, 0, 0,
        0, 0, 0, 0x70, ...ascii("iprp"), 0, 0, 0, 0x68, ...ascii("ipco")],
    ];
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 8000; i++) {
      const len = next() % 201;
      const buf = new Uint8Array(len);
      for (let j = 0; j < len; j++) buf[j] = next() & 0xff;
      const sig = sigs[i % sigs.length]!;
      buf.set(sig.slice(0, len));
      const r = parseImageHead(buf, null);
      expect(["size", "need", "reason"]).toContain(r.kind);
    }
  });
});

describe("parseImageHead: headers past the 64 KiB window (29d)", () => {
  it("a square PNG past 64 KiB reports its IHDR size", () => {
    const full = png(300, 300, pngChunk("iCCP", new Array<number>(100 * 1024).fill(0x41)));
    expect(parseImageHead(full.subarray(0, IMAGE_HEADER_BYTES), "image/png")).toEqual({ kind: "size", format: "png", width: 300, height: 300 });
  });

  it("a 40x20 PNG with 100 KiB of private chunks answers need at the next chunk header, then resolves to 40x20", () => {
    const full = png(40, 20, pngChunk("prVt", new Array<number>(100 * 1024).fill(0x41)));
    const need = parseImageHead(full.subarray(0, IMAGE_HEADER_BYTES), "image/png");
    expect(need).toMatchObject({ kind: "need", offset: 33 + 8 + 100 * 1024 + 4 });
    if (need.kind !== "need") throw new Error("expected need");
    expect(parseImageHead(full.subarray(need.offset, need.offset + IMAGE_HEADER_BYTES), "image/png", need.state)).toEqual({ kind: "size", format: "png", width: 40, height: 20 });
  });

  it("an eXIf of orientation 6 found in the continuation window resolves to 20x40", () => {
    const full = png(40, 20, pngChunk("prVt", new Array<number>(100 * 1024).fill(0x41)), pngChunk("eXIf", tiffOrientation("MM", 6)));
    const need = parseImageHead(full.subarray(0, IMAGE_HEADER_BYTES), "image/png");
    if (need.kind !== "need") throw new Error("expected need");
    expect(parseImageHead(full.subarray(need.offset, need.offset + IMAGE_HEADER_BYTES), "image/png", need.state)).toEqual({ kind: "size", format: "png", width: 20, height: 40 });
  });

  it("a continuation window that ends before IDAT with no eXIf asks again", () => {
    const chunk = pngChunk("prVt", new Array<number>(100 * 1024).fill(0x41));
    const full = png(40, 20, chunk, chunk);
    const first = parseImageHead(full.subarray(0, IMAGE_HEADER_BYTES), "image/png");
    if (first.kind !== "need") throw new Error("expected need");
    const second = parseImageHead(full.subarray(first.offset, first.offset + IMAGE_HEADER_BYTES), "image/png", first.state);
    expect(second).toMatchObject({ kind: "need", offset: 33 + 2 * (8 + 100 * 1024 + 4) });
  });

  it("a JPEG with 100 KiB of APP segments before SOF answers need, then its size", () => {
    const full = bytes(
      [0xff, 0xd8],
      jpegApp1(60_000),
      [0xff, 0xe2, ...be16(40_002), ...new Array<number>(40_000).fill(0)],
      jpegSof(0xc0, 800, 533),
    );
    const first = parseImageHead(full.subarray(0, IMAGE_HEADER_BYTES), "image/jpeg");
    expect(first).toMatchObject({ kind: "need" });
    if (first.kind !== "need") throw new Error("expected need");
    // SOI (2), then each segment is its marker (2), length (2) and payload.
    expect(first.offset).toBe(2 + 4 + 60_000 + 4 + 40_000);
    expect(parseImageHead(full.subarray(first.offset, first.offset + IMAGE_HEADER_BYTES), "image/jpeg", first.state)).toEqual({ kind: "size", format: "jpeg", width: 800, height: 533 });
  });

  it("an Exif APP1 cut by the window is read whole from its marker", () => {
    const filler = [0xff, 0xe2, ...be16(65_500), ...new Array<number>(65_498).fill(0)];
    const exif = exifApp1("MM", [[ORIENTATION, SHORT, 1, 6]]);
    const full = bytes([0xff, 0xd8], filler, exif, jpegSof(0xc0, 800, 533));
    const first = parseImageHead(full.subarray(0, IMAGE_HEADER_BYTES), "image/jpeg");
    if (first.kind !== "need") throw new Error("expected need");
    expect(parseImageHead(full.subarray(first.offset, first.offset + IMAGE_HEADER_BYTES), "image/jpeg", first.state)).toEqual({ kind: "size", format: "jpeg", width: 533, height: 800 });
  });
});

describe("parseImageHead: a square PNG is sized only where the walk runs out of window (29d fix)", () => {
  it("a square PNG with IEND before IDAT is malformed, not its IHDR size", () => {
    expect(parseImageHead(bytes(PNG_SIG, IHDR(300, 300), pngChunk("IEND", [])), null)).toEqual({ kind: "reason", reason: "malformed" });
  });

  it("a square PNG with a chunk length past the spec's ceiling is malformed", () => {
    expect(parseImageHead(bytes(PNG_SIG, IHDR(300, 300), be32(0x80000000), ascii("tEXt")), null)).toEqual({ kind: "reason", reason: "malformed" });
  });

  it("a square PNG with a malformed IHDR length is still malformed", () => {
    const longIhdr = bytes(PNG_SIG, be32(14), ascii("IHDR"), be32(300), be32(300), [8, 2, 0, 0, 0, 0], [0, 0, 0, 0], IDAT_START);
    expect(parseImageHead(longIhdr, null)).toEqual({ kind: "reason", reason: "malformed" });
  });

  it("a square PNG whose eXIf is cut by the window is sized from IHDR", () => {
    const cut = png(300, 300, pngChunk("eXIf", tiffOrientation("MM", 6)));
    expect(parseImageHead(cut.subarray(0, 33 + 8 + 10), "image/png")).toEqual({ kind: "size", format: "png", width: 300, height: 300 });
  });
});

describe("parseImageHead: the resume path never throws (29d fix)", () => {
  it("random 64 KiB windows fed to every state a first read can leave", () => {
    const starts: Uint8Array[] = [
      png(40, 20, pngChunk("prVt", new Array<number>(100 * 1024).fill(0x41))).subarray(0, IMAGE_HEADER_BYTES),
      bytes([0xff, 0xd8], [0xff, 0xe2, ...be16(40_002), ...new Array<number>(40_000).fill(0)], [0xff, 0xe2, ...be16(40_002), ...new Array<number>(20_000).fill(0)]).subarray(0, IMAGE_HEADER_BYTES),
      bytes([0xff, 0xd8], exifApp1("MM", [[ORIENTATION, SHORT, 1, 6]]), [0xff, 0xe2, ...be16(65_000)]).subarray(0, 60),
    ];
    let seed = 0x1badf00d;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    let resumed = 0;
    for (const start of starts) {
      for (let i = 0; i < 300; i++) {
        let r = parseImageHead(start, null);
        for (let step = 0; step < 3 && r.kind === "need"; step++) {
          const window = new Uint8Array(i % 3 === 0 ? IMAGE_HEADER_BYTES : next() % 400);
          for (let j = 0; j < window.length; j++) window[j] = next() & 0xff;
          // Some windows open on something that parses, so the walk goes on.
          if (i % 2 === 0 && window.length > 12) window.set(r.state.format === "png" ? [0, 0, 0, 4, ...ascii("prVt")] : [0xff, 0xe2, 0, 6]);
          r = parseImageHead(window, null, r.state);
          resumed++;
          expect(["size", "need", "reason"]).toContain(r.kind);
        }
      }
    }
    expect(resumed).toBeGreaterThan(500);
  });
});

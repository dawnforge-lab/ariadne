/**
 * The image header parser: intrinsic width/height from the first 64 KiB.
 *
 * Every header here is built by hand from the format specs (PNG, JPEG T.81
 * markers, GIF89a, WebP RIFF container, ISOBMFF/HEIF `ispe`), so each exact
 * dimension is derived from the bytes written below and not from a library.
 */
import { describe, expect, it } from "vitest";
import { IMAGE_HEADER_BYTES, readImageSize } from "../../src/crawl/resources/image-size.js";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (w: number, h: number): Uint8Array =>
  bytes(PNG_SIG, be32(13), ascii("IHDR"), be32(w), be32(h), [8, 2, 0, 0, 0]);

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

describe("readImageSize: the size the browser lays out, rotation applied (29b final review F3)", () => {
  it("a JPEG whose EXIF orientation is 6 is its stored size turned, in either byte order", () => {
    for (const order of ["II", "MM"] as const) {
      expect(readImageSize(orientedJpeg(order, 6), "image/jpeg"), order).toEqual({ kind: "size", format: "jpeg", width: 3000, height: 4000 });
    }
  });

  it("orientations 5, 7 and 8 turn it too; 1 to 4 do not", () => {
    for (const o of [5, 6, 7, 8]) {
      expect(readImageSize(orientedJpeg("MM", o), null), String(o)).toMatchObject({ width: 3000, height: 4000 });
    }
    for (const o of [1, 2, 3, 4]) {
      expect(readImageSize(orientedJpeg("II", o), null), String(o)).toMatchObject({ width: 4000, height: 3000 });
    }
  });

  it("finds the orientation among other IFD0 entries", () => {
    const head = bytes(
      [0xff, 0xd8],
      exifApp1("II", [[0x010f, 2, 4, 0], [0x0110, 2, 4, 0], [ORIENTATION, SHORT, 1, 8], [0x011a, 5, 1, 0]]),
      jpegSof(0xc2, 640, 480),
    );
    expect(readImageSize(head, "image/jpeg")).toEqual({ kind: "size", format: "jpeg", width: 480, height: 640 });
  });

  it("an APP1 that is not Exif (XMP) leaves the stored size alone", () => {
    const xmp = [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta/>")];
    const head = bytes([0xff, 0xd8], [0xff, 0xe1, ...be16(xmp.length + 2), ...xmp], jpegSof(0xc0, 4000, 3000));
    expect(readImageSize(head, null)).toMatchObject({ width: 4000, height: 3000 });
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
      expect(readImageSize(head, "image/jpeg"), name).toEqual(stored);
    }
  });

  it("an AVIF whose irot angle is 1 or 3 is its ispe turned; 0 and 2 are not", () => {
    expect(readImageSize(rotatedAvif(1920, 1080, irot(1)), "image/avif")).toEqual({ kind: "size", format: "avif", width: 1080, height: 1920 });
    expect(readImageSize(rotatedAvif(1920, 1080, irot(3)), "image/avif")).toMatchObject({ width: 1080, height: 1920 });
    expect(readImageSize(rotatedAvif(1920, 1080, irot(2)), "image/avif")).toMatchObject({ width: 1920, height: 1080 });
    expect(readImageSize(rotatedAvif(1920, 1080, irot(0)), "image/avif")).toMatchObject({ width: 1920, height: 1080 });
    // The six reserved bits above the angle are not part of it.
    expect(readImageSize(rotatedAvif(1920, 1080, irot(0xfc | 1)), "image/avif")).toMatchObject({ width: 1080, height: 1920 });
  });

  it("an irot before the ispe counts the same", () => {
    const head = bytes(
      box("ftyp", ascii("avif"), be32(0), ascii("avif")),
      box("meta", [0, 0, 0, 0], box("iprp", box("ipco", irot(1), box("ispe", [0, 0, 0, 0], be32(300), be32(200))))),
    );
    expect(readImageSize(head, "image/avif")).toMatchObject({ width: 200, height: 300 });
  });

  it("an AVIF whose ipco is cut off after its ispe is header-beyond-limit: an irot may follow", () => {
    const full = rotatedAvif(1920, 1080, box("colr", ascii("nclx"), [0, 0, 0, 0, 0]), irot(1));
    expect(readImageSize(full.subarray(0, full.length - 4), "image/avif")).toEqual({ kind: "none", reason: "header-beyond-limit" });
  });
});

describe("readImageSize: a dimension past int4 is malformed, never a size", () => {
  it("an AVIF ispe of 0xFFFFFFFF", () => {
    expect(readImageSize(avif(0xffffffff, 100), "image/avif")).toEqual({ kind: "none", reason: "malformed" });
    expect(readImageSize(avif(100, 0xffffffff), "image/avif")).toEqual({ kind: "none", reason: "malformed" });
  });
  it("a PNG with width 0x80000000, and height 0xFFFFFFFF", () => {
    expect(readImageSize(png(0x80000000, 10), "image/png")).toEqual({ kind: "none", reason: "malformed" });
    expect(readImageSize(png(10, 0xffffffff), "image/png")).toEqual({ kind: "none", reason: "malformed" });
  });
  it("2^31-1 itself is still a size", () => {
    expect(readImageSize(png(0x7fffffff, 1), "image/png")).toEqual({ kind: "size", format: "png", width: 2147483647, height: 1 });
  });
});

describe("readImageSize: one per format", () => {
  it("PNG 1600x1200", () => {
    expect(readImageSize(png(1600, 1200), "image/png")).toEqual({ kind: "size", format: "png", width: 1600, height: 1200 });
  });

  it("JPEG with an APP1 segment before SOF2, 800x533", () => {
    const head = bytes([0xff, 0xd8], jpegApp1(300), jpegSof(0xc2, 800, 533), [0xff, 0xda]);
    expect(readImageSize(head, "image/jpeg")).toEqual({ kind: "size", format: "jpeg", width: 800, height: 533 });
  });

  it("GIF 1x1", () => {
    const head = bytes(ascii("GIF89a"), le16(1), le16(1), [0, 0, 0]);
    expect(readImageSize(head, "image/gif")).toEqual({ kind: "size", format: "gif", width: 1, height: 1 });
  });

  it("WebP VP8 640x480", () => {
    const head = bytes(ascii("RIFF"), le32(30), ascii("WEBP"), ascii("VP8 "), le32(18), [0, 0, 0], [0x9d, 0x01, 0x2a], le16(640), le16(480), [0, 0, 0, 0]);
    expect(readImageSize(head, "image/webp")).toEqual({ kind: "size", format: "webp", width: 640, height: 480 });
  });

  it("WebP VP8L 641x481", () => {
    const packed = ((641 - 1) | ((481 - 1) << 14)) >>> 0;
    const head = bytes(ascii("RIFF"), le32(30), ascii("WEBP"), ascii("VP8L"), le32(10), [0x2f], le32(packed), [0, 0, 0, 0, 0]);
    expect(readImageSize(head, "image/webp")).toEqual({ kind: "size", format: "webp", width: 641, height: 481 });
  });

  it("WebP VP8X 4000x3000", () => {
    const head = bytes(ascii("RIFF"), le32(30), ascii("WEBP"), ascii("VP8X"), le32(10), [0, 0, 0, 0], le24(3999), le24(2999));
    expect(readImageSize(head, "image/webp")).toEqual({ kind: "size", format: "webp", width: 4000, height: 3000 });
  });

  it("AVIF ispe 1920x1080", () => {
    expect(readImageSize(avif(1920, 1080), "image/avif")).toEqual({ kind: "size", format: "avif", width: 1920, height: 1080 });
  });
});

describe("readImageSize: nothing is guessed", () => {
  it("SVG by content type", () => {
    const svg = bytes(ascii('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'));
    expect(readImageSize(svg, "image/svg+xml")).toEqual({ kind: "none", reason: "svg" });
  });

  it("SVG by a leading <svg or <?xml with no useful content type", () => {
    expect(readImageSize(bytes(ascii("  <svg/>")), null)).toEqual({ kind: "none", reason: "svg" });
    expect(readImageSize(bytes(ascii('<?xml version="1.0"?><svg/>')), "application/octet-stream")).toEqual({ kind: "none", reason: "svg" });
  });

  it("2 KB of 0x41 under image/png is unknown-format", () => {
    expect(readImageSize(new Uint8Array(2048).fill(0x41), "image/png")).toEqual({ kind: "none", reason: "unknown-format" });
  });

  it("a JPEG whose 70 KB APP1 pushes SOF past the limit is header-beyond-limit", () => {
    const full = bytes([0xff, 0xd8], jpegApp1(70_000), jpegSof(0xc0, 800, 533));
    const head = full.subarray(0, IMAGE_HEADER_BYTES);
    expect(head.length).toBe(65_536);
    expect(readImageSize(head, "image/jpeg")).toEqual({ kind: "none", reason: "header-beyond-limit" });
  });

  it("an AVIF whose meta box is cut off before ispe is header-beyond-limit", () => {
    const full = avif(1920, 1080);
    expect(readImageSize(full.subarray(0, full.length - 20), "image/avif")).toEqual({ kind: "none", reason: "header-beyond-limit" });
  });

  it("PNG with width 0 is malformed", () => {
    expect(readImageSize(png(0, 10), "image/png")).toEqual({ kind: "none", reason: "malformed" });
  });

  it("a JPEG SOF excludes DHT/JPG/DAC markers", () => {
    const head = bytes([0xff, 0xd8], [0xff, 0xc4, ...be16(4), 0, 0], jpegSof(0xc1, 20, 10));
    expect(readImageSize(head, null)).toEqual({ kind: "size", format: "jpeg", width: 20, height: 10 });
  });

  it("an empty array is empty", () => {
    expect(readImageSize(new Uint8Array(0), "image/png")).toEqual({ kind: "none", reason: "empty" });
  });
});

describe("readImageSize: never throws", () => {
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
      const r = readImageSize(buf, null);
      expect(["size", "none"]).toContain(r.kind);
    }
  });
});

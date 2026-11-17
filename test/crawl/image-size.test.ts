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
  it("2000 random buffers behind real signatures always return a kind", () => {
    const sigs: number[][] = [
      PNG_SIG,
      [0xff, 0xd8, 0xff],
      ascii("GIF89a"),
      [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")],
      [0, 0, 0, 24, ...ascii("ftyp"), ...ascii("avif")],
    ];
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
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

/**
 * Real image bytes and a Range-aware image server, for the resource pass's
 * intrinsic-size reading (Phase 29b).
 *
 * `pngBytes` builds a PNG a decoder would accept, with `node:zlib`: signature,
 * IHDR, one IDAT of all-zero scanlines, IEND, each chunk with its CRC-32. The
 * pixels are blank, which is all the size reader (and the renderer's stand-in
 * images) ever need, and an all-zero scanline deflates to a few kilobytes even
 * at 1600x1200, so the fixture is cheap to serve.
 *
 * `serveImage` is the server half. It answers a `Range` request the way the
 * four kinds of real server do, so each branch of the pass is driven by a
 * server that behaves that way and not by a stub:
 *   - `honour`: 206 with `Content-Range: bytes a-b/N`;
 *   - `ignore`: 200 with the whole body (most naive servers);
 *   - `star`:   206 with `Content-Range: bytes a-b/*` (total unknown);
 *   - `unsatisfiable`: 416 to any Range request (a server that refuses ranges).
 * A request with no `Range` header is always a plain 200 with the whole body,
 * and a HEAD is a 200 with headers only.
 */
import { deflateSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A real, decodable `width` x `height` greyscale PNG. `padTo`, when given,
 * appends a private ancillary chunk (before IEND, which decoders skip) so the
 * file is exactly that many bytes: a test that needs "a 30,000 byte image" gets
 * one whose header still reads as the size it names.
 */
export function pngBytes(width: number, height: number, padTo?: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale; compression, filter, interlace stay 0
  const scanline = Buffer.alloc(1 + width); // filter byte 0, then blank pixels
  const raw = Buffer.concat(Array.from({ length: height }, () => scanline));
  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw))];
  const iend = chunk("IEND", Buffer.alloc(0));
  if (padTo !== undefined) {
    const used = parts.reduce((n, p) => n + p.length, 0) + iend.length;
    // An empty-bodied chunk costs 12 bytes; its body supplies the rest.
    const body = padTo - used - 12;
    if (body < 0) {
      throw new RangeError(`pngBytes: ${width}x${height} is already ${used} bytes, over padTo ${padTo}`);
    }
    parts.push(chunk("prVt", Buffer.alloc(body, 0x61)));
  }
  parts.push(iend);
  return Buffer.concat(parts);
}

/**
 * The start of a baseline JPEG: SOI, optional APP1 segments totalling `app1Bytes`
 * payload bytes (the EXIF slot that pushes the frame header past a 64 KiB read),
 * then SOF0 carrying `width` x `height`. Not decodable (no scan data), and it
 * does not need to be: the size reader stops at the frame header.
 */
export function jpegHeader(width: number, height: number, app1Bytes = 0): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  // One segment's length field is 16 bits, so a payload past 65,533 bytes is
  // several APP1 segments back to back: still all metadata before the frame.
  for (let left = app1Bytes; left > 0; ) {
    const payload = Math.min(left, 60_000);
    const app1 = Buffer.alloc(4);
    app1[0] = 0xff;
    app1[1] = 0xe1;
    app1.writeUInt16BE(payload + 2, 2);
    parts.push(app1, Buffer.alloc(payload, 0x45));
    left -= payload;
  }
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  sof.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 10);
  parts.push(sof);
  return Buffer.concat(parts);
}

export type RangeBehaviour = "honour" | "ignore" | "star" | "unsatisfiable";

export interface ServeImageOpts {
  bytes: Buffer;
  contentType: string;
  range: RangeBehaviour;
  cacheControl?: string;
}

/** Serve `bytes` as `contentType`, answering a Range request as `range` says. */
export function serveImage(req: IncomingMessage, res: ServerResponse, opts: ServeImageOpts): void {
  const { bytes, contentType } = opts;
  const base: Record<string, string> = { "content-type": contentType };
  if (opts.cacheControl !== undefined) base["cache-control"] = opts.cacheControl;
  const head = req.method === "HEAD";
  const rangeHeader = req.headers.range;
  const match = rangeHeader === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);

  if (head || match === null || opts.range === "ignore") {
    res.writeHead(200, { ...base, "content-length": String(bytes.length) });
    res.end(head ? undefined : bytes);
    return;
  }
  if (opts.range === "unsatisfiable") {
    res.writeHead(416, { ...base, "content-range": `bytes */${bytes.length}`, "content-length": "0" });
    res.end();
    return;
  }
  const first = Number(match[1]);
  const last = Math.min(match[2] === "" ? bytes.length - 1 : Number(match[2]), bytes.length - 1);
  const slice = bytes.subarray(first, last + 1);
  const total = opts.range === "star" ? "*" : String(bytes.length);
  res.writeHead(206, {
    ...base,
    "content-range": `bytes ${first}-${last}/${total}`,
    "content-length": String(slice.length),
  });
  res.end(slice);
}

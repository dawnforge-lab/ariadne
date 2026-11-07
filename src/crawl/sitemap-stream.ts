/**
 * A sitemap read as a stream, up to the protocol's 50 MB uncompressed.
 *
 * Phase 26c (P26c-T7). Until now discovery buffered a sitemap whole and parsed
 * it with fast-xml-parser, so it capped the document at 10 MB: a legal 10–50 MB
 * sitemap was dropped. Here the body flows through, chunk by chunk —
 * gunzip (when the bytes say gzip), a streaming `TextDecoder`, and
 * htmlparser2's tokenizer in XML mode — and each `<url>` / `<sitemap>` is handed
 * to the caller the moment it closes. Memory is O(chunk + one entry), never
 * O(document) (hard rules 4 and 6). The caller's `drain` is awaited after every
 * chunk, so its sink flushes before the next chunk is read.
 *
 * Today's reading is kept wherever it is a judgement rather than a mechanism,
 * so discovery can swap this in without moving a reason string:
 *  - gzip is chosen by the magic bytes `1f 8b`, never the headers, and at most
 *    two rounds (a .gz file the server gzipped again in transit);
 *  - the cap counts DECOMPRESSED bytes, so a gzip bomb stops at it;
 *  - a `<!DOCTYPE` in the first 4,096 characters refuses the document, before
 *    the parser sees a byte of it, with today's reason;
 *  - a root other than `urlset` / `sitemapindex` refuses it, with today's
 *    reason. Names are matched case-sensitively, as XML and the old parser do,
 *    on the local name: `sm:urlset` is `urlset`, `xhtml:link` is `link`;
 *  - a `<loc>` / `<lastmod>` value is its text (CDATA included, entities
 *    decoded), trimmed; a blank one, a repeated one, or one holding an element
 *    is no value — the cases where fast-xml-parser gave a non-string;
 *  - an entry with no `<loc>` value is counted in `malformedEntries`.
 *
 * Three readings differ from the buffered parser, deliberately:
 *  - an empty `<urlset></urlset>` is a urlset with no entries (fast-xml-parser
 *    gave it the value "" and discovery refused it as having no root);
 *  - numeric character references (`&#38;`) are decoded, as XML defines them
 *    (fast-xml-parser decoded only the five named entities);
 *  - an unknown charset label is refused, never read as UTF-8.
 *
 * An oversized document keeps the entries read before the cap (deviation 3):
 * the result says `oversized: true` with the bytes read, and the entry the cap
 * cut through is never emitted.
 */
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser } from "htmlparser2";
import { MAX_HREFLANG_PAIRS } from "./parse/page-analyzer.js";

/** The sitemaps.org protocol's limit, on the uncompressed document. */
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

export type SitemapUrlEntry = {
  loc: string;
  lastmod: string | null;
  alternates: { hreflang: string; href: string }[];
};

export type SitemapStreamResult =
  | { kind: "urlset" | "index"; bytes: number; oversized: boolean; malformedEntries: number }
  | { kind: "refused"; reason: string };

/** Discovery's refusal texts, verbatim, so the reasons on record do not move. */
const DOCTYPE_REASON = "refused: <!DOCTYPE declaration in a sitemap (entity-expansion risk)";
const ROOT_REASON = "no <urlset> or <sitemapindex> root element";

/**
 * How much of the document is searched for a DTD: the prolog, where a
 * `<!DOCTYPE` can legally be, generously. The same number discovery used.
 */
const PROLOG_SEARCH_CHARS = 4_096;
const DOCTYPE_PATTERN = /<!DOCTYPE/i;

/** gzip's two magic bytes, trusted over the headers. */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const MAX_GZIP_ROUNDS = 2;

/** `xhtml:link` -> `link`. */
function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

/**
 * Pull the first two bytes of `source` to see whether it is gzip, and hand
 * back a source that replays them. Closing the replay closes `source`.
 */
async function sniffGzip(
  source: AsyncIterable<Uint8Array>,
): Promise<{ gzip: boolean; source: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]();
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let finished = false;
  while (headBytes < 2) {
    const next = await iterator.next();
    if (next.done === true) {
      finished = true;
      break;
    }
    head.push(next.value);
    headBytes += next.value.byteLength;
  }
  const prefix = Buffer.concat(head).subarray(0, 2);
  const gzip = prefix[0] === GZIP_MAGIC_0 && prefix[1] === GZIP_MAGIC_1;

  async function* replay(): AsyncGenerator<Uint8Array> {
    try {
      while (head.length > 0) {
        const chunk = head.shift();
        if (chunk !== undefined) yield chunk;
      }
      while (!finished) {
        let next: IteratorResult<Uint8Array>;
        try {
          next = await iterator.next();
        } catch (error) {
          finished = true; // a failed iterator is done; do not ask it to return
          throw error;
        }
        if (next.done === true) {
          finished = true;
          break;
        }
        yield next.value;
      }
    } finally {
      // Stopped early (the cap, a refusal): release the body.
      if (!finished) await iterator.return?.();
    }
  }
  return { gzip, source: replay() };
}

/**
 * Inflate a gzip stream, output chunk by output chunk. Stopping the iteration
 * destroys the inflater and, through the pipeline, the source — so a bomb is
 * only ever inflated as far as it is read.
 */
async function* gunzipped(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const inflater = createGunzip();
  const done = pipeline(Readable.from(source, { objectMode: false }), inflater);
  let completed = false;
  try {
    for await (const chunk of inflater as AsyncIterable<Buffer>) yield chunk;
    completed = true;
  } finally {
    if (completed) {
      await done;
    } else {
      inflater.destroy();
      // Either the consumer stopped early, and this is the premature close we
      // caused, or the iteration threw, and that error is already on its way
      // out of this generator. Neither is a second error to report.
      await done.catch(() => undefined);
    }
  }
}

/** Undo up to two rounds of gzip, each chosen by the magic bytes. */
async function decompressed(body: AsyncIterable<Uint8Array>): Promise<AsyncIterable<Uint8Array>> {
  let source = body;
  for (let round = 0; round < MAX_GZIP_ROUNDS; round++) {
    const sniffed = await sniffGzip(source);
    if (!sniffed.gzip) return sniffed.source;
    source = gunzipped(sniffed.source);
  }
  return source;
}

/** A `<loc>` or `<lastmod>`: its text, and whether it is still a plain value. */
interface FieldState {
  text: string;
  count: number;
  hasElement: boolean;
}

const emptyField = (): FieldState => ({ text: "", count: 0, hasElement: false });

/** fast-xml-parser's reading: one text-only element, trimmed, non-blank. */
function fieldValue(field: FieldState): string | null {
  if (field.count !== 1 || field.hasElement) return null;
  const trimmed = field.text.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Stream one sitemap document, emitting each entry as it closes.
 *
 * Throws what the body or the inflater throws (a reset connection, a corrupt
 * gzip): a document that could not be read is the caller's failure to record,
 * never an empty sitemap.
 */
export async function parseSitemapStream(
  body: AsyncIterable<Uint8Array>,
  opts: {
    maxBytes: number;
    charset: string | null;
    onUrl: (e: SitemapUrlEntry) => void;
    onSitemap: (loc: string, lastmod: string | null) => void;
    drain: () => Promise<void>;
  },
): Promise<SitemapStreamResult> {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(opts.charset ?? "utf-8", { fatal: false });
  } catch (error) {
    if (error instanceof RangeError) {
      return { kind: "refused", reason: `refused: unknown charset label "${opts.charset}"` };
    }
    throw error;
  }

  let kind: "urlset" | "index" | null = null;
  let refusal: string | null = null;
  let rootClosed = false;
  let malformedEntries = 0;

  // Open elements, the root counting as 1: an entry is depth 2, its fields 3.
  let depth = 0;
  let inEntry = false;
  let field: FieldState | null = null;
  let loc = emptyField();
  let lastmod = emptyField();
  let alternates: { hreflang: string; href: string }[] = [];

  const ignoring = (): boolean => refusal !== null || rootClosed;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (ignoring()) return;
        depth++;
        const local = localName(name);
        if (depth === 1) {
          if (local === "urlset") kind = "urlset";
          else if (local === "sitemapindex") kind = "index";
          else refusal = ROOT_REASON;
          return;
        }
        if (depth === 2) {
          if (local === (kind === "urlset" ? "url" : "sitemap")) {
            inEntry = true;
            loc = emptyField();
            lastmod = emptyField();
            alternates = [];
          }
          return;
        }
        if (!inEntry) return;
        if (depth === 3) {
          if (local === "loc") field = loc;
          else if (local === "lastmod") field = lastmod;
          else field = null;
          if (field !== null) field.count++;
          if (
            local === "link" &&
            kind === "urlset" &&
            alternates.length < MAX_HREFLANG_PAIRS
          ) {
            const rel = attribs["rel"]?.trim().toLowerCase();
            const hreflang = attribs["hreflang"];
            const href = attribs["href"];
            if (rel && rel.split(/\s+/).includes("alternate") && hreflang && href !== undefined) {
              alternates.push({ hreflang, href });
            }
          }
          return;
        }
        if (depth === 4 && field !== null) field.hasElement = true;
      },
      ontext(text) {
        if (ignoring()) return;
        if (depth === 3 && field !== null) field.text += text;
      },
      onclosetag() {
        if (ignoring()) return;
        if (depth === 3) {
          field = null;
        } else if (depth === 2 && inEntry) {
          inEntry = false;
          const locValue = fieldValue(loc);
          if (locValue === null) {
            malformedEntries++;
          } else if (kind === "urlset") {
            opts.onUrl({ loc: locValue, lastmod: fieldValue(lastmod), alternates });
          } else {
            opts.onSitemap(locValue, fieldValue(lastmod));
          }
        } else if (depth === 1) {
          rootClosed = true;
        }
        depth--;
      },
    },
    { xmlMode: true },
  );

  // The prolog is held back until the DOCTYPE check has seen all of it, so a
  // refused document never reaches the parser (or the caller's sink).
  let prolog: string | null = "";
  const feed = (text: string, last: boolean): void => {
    if (prolog === null) {
      parser.write(text);
      return;
    }
    prolog += text;
    if (prolog.length < PROLOG_SEARCH_CHARS && !last) return;
    const held = prolog;
    prolog = null;
    if (DOCTYPE_PATTERN.test(held.slice(0, PROLOG_SEARCH_CHARS))) {
      refusal = DOCTYPE_REASON;
      return;
    }
    parser.write(held);
  };

  let bytes = 0;
  let oversized = false;
  for await (const chunk of await decompressed(body)) {
    const remaining = opts.maxBytes - bytes;
    const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    if (kept !== chunk) oversized = true;
    bytes += kept.byteLength;
    feed(decoder.decode(kept, { stream: true }), oversized);
    if (refusal !== null) return { kind: "refused", reason: refusal };
    await opts.drain();
    if (oversized) break;
  }

  if (!oversized) {
    feed(decoder.decode(), true);
    if (refusal !== null) return { kind: "refused", reason: refusal };
    // Not on the oversized path: end() closes every open element, which would
    // emit the entry the cap cut through.
    parser.end();
    if (refusal !== null) return { kind: "refused", reason: refusal };
    await opts.drain();
  }

  if (kind === null) return { kind: "refused", reason: ROOT_REASON };
  return { kind, bytes, oversized, malformedEntries };
}

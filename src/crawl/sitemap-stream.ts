/**
 * A sitemap read as a stream, up to the protocol's 50 MB uncompressed.
 *
 * Phase 26c (P26c-T7). Until now discovery buffered a sitemap whole and parsed
 * it with fast-xml-parser, so it capped the document at 10 MB: a legal 10–50 MB
 * sitemap was dropped. Here the body flows through, chunk by chunk —
 * gunzip (when the bytes say gzip), a streaming `TextDecoder`, and
 * htmlparser2's tokenizer in XML mode — and each `<url>` / `<sitemap>` is handed
 * to the caller the moment it closes. The caller's `drain` is awaited after
 * every chunk, so its sink flushes before the next chunk is read.
 *
 * THE MEMORY BOUND, stated as it is (hard rules 4 and 6; final review M3):
 * O(chunk + one entry), and one entry's own state is capped — its `<loc>` text
 * at `LOC_TEXT_MAX` (`INDEXED_URL_MAX` + 1) characters, its `<lastmod>` at
 * `LASTMOD_TEXT_MAX` (64), its alternates at `MAX_HREFLANG_PAIRS`, the rest
 * counted. What this module does not cap is an attribute value or a tag name:
 * htmlparser2 buffers each one whole until its tag ends, so one pathological
 * `href` (and the up to 200 kept alternates holding such values) is bounded only
 * by the document cap, `SITEMAP_MAX_BYTES`. A real sitemap's entry is a few
 * hundred bytes; the worst case is 50 MB, never more.
 *  - a `<loc>` whose text runs past `LOC_TEXT_MAX` (whitespace aside) is not
 *    read further and the entry is reported through `onOverlongLoc`, never
 *    emitted with a cut URL. Measured on the raw text, so a loc that would
 *    resolve shorter (dot segments) is still over-long here;
 *  - a `<lastmod>` past 64 characters is kept as its first 64 and `…`, which
 *    no date-time pattern matches, so it is still reported invalid.
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
 *  - an entry with no `<loc>` value is counted in `malformedEntries`;
 *  - an entry still open when the stream ends (a document cut off mid-entry,
 *    even after its `</loc>`) is counted in `malformedEntries` and never
 *    emitted: a half-written URL is not one the site declared.
 *
 * THE STREAM OWNS THE BODY. Every exit releases it — normal completion, every
 * refusal (the charset one included), the cap, and a thrown error — by
 * closing its iterator (`return()`), which for a network body destroys the
 * socket's stream. The caller never has to drain or destroy it. An async
 * generator, and a Node `Readable`'s iterator, run their cleanup only once
 * started, so a body refused before reading (unknown charset) has one chunk
 * pulled and is then closed.
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
import { INDEXED_URL_MAX } from "./parse/url-utils.js";

/** The sitemaps.org protocol's limit, on the uncompressed document. */
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

export type SitemapUrlEntry = {
  loc: string;
  lastmod: string | null;
  /** At most `MAX_HREFLANG_PAIRS`, in document order. */
  alternates: { hreflang: string; href: string }[];
  /**
   * Well-formed alternates (`rel` holding `alternate`, a non-empty `hreflang`,
   * an `href`) past `MAX_HREFLANG_PAIRS` in this `<url>`: counted, not kept
   * (final review I5). On the entry rather than the stream's result, so an entry
   * read before an on-the-wire cap or a mid-stream failure keeps its count.
   */
  alternatesCapped: number;
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

/**
 * Close a body that will not be read. `return()` alone does not release an
 * iterator that never started (an async generator's `finally`, and a Node
 * `Readable` iterator's destroy, run only once it has), so one chunk is
 * pulled first.
 */
async function release(body: AsyncIterable<Uint8Array>): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();
  let finished = false;
  try {
    finished = (await iterator.next()).done === true;
  } finally {
    if (!finished) await iterator.return?.();
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

/**
 * How much of a `<loc>`'s text is kept: one character past `INDEXED_URL_MAX`,
 * so a kept value of this length is still measured over-long by discovery, and
 * any more is over-long without being read (final review M3).
 */
export const LOC_TEXT_MAX = INDEXED_URL_MAX + 1;

/**
 * How much of a `<lastmod>`'s text is kept. The longest W3C date-time a site
 * writes (nanoseconds and an offset) is 35 characters; 64 is generous.
 */
export const LASTMOD_TEXT_MAX = 64;

/** A `<loc>` or `<lastmod>`: its text, and whether it is still a plain value. */
export interface FieldState {
  /** The text from its first non-whitespace character, at most `max` long. */
  text: string;
  count: number;
  hasElement: boolean;
  max: number;
  /** Text other than whitespace arrived past `max`: the value is longer than kept. */
  overflow: boolean;
}

export const emptyField = (max: number): FieldState => ({
  text: "",
  count: 0,
  hasElement: false,
  max,
  overflow: false,
});

/**
 * Append a text node to a field, never past its cap. Leading whitespace is not
 * kept (the value is trimmed, and an indent must not spend the cap); whitespace
 * past the cap may be the value's own trailing whitespace and changes nothing;
 * anything else past it sets `overflow` and is dropped.
 */
export function appendFieldText(field: FieldState, text: string): void {
  if (field.overflow) return;
  const piece = field.text === "" ? text.trimStart() : text;
  const room = field.max - field.text.length;
  if (piece.length <= room) {
    field.text += piece;
    return;
  }
  field.text += piece.slice(0, room);
  if (/\S/.test(piece.slice(room))) field.overflow = true;
}

/** fast-xml-parser's reading: one text-only element, trimmed, non-blank. */
function fieldValue(field: FieldState): string | null {
  if (field.count !== 1 || field.hasElement) return null;
  const trimmed = field.text.trim();
  if (trimmed === "") return null;
  // Only a `<lastmod>` gets here overflowed (an over-long `<loc>` is reported,
  // never read as a value): its first characters and an ellipsis, which no
  // date-time pattern matches, so `sitemap.lastmod-invalid` still reports it.
  return field.overflow ? `${trimmed}…` : trimmed;
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
    /**
     * A finished entry whose one `<loc>` ran past `LOC_TEXT_MAX`: no index can
     * hold it, and its text was not read past the cap, so it is reported here
     * and never emitted (nor counted malformed). `"url"` in a urlset,
     * `"sitemap"` in an index. `kept` is the text read before the cap
     * (`LOC_TEXT_MAX` characters, leading whitespace aside), so the caller can
     * name the entry; it is a prefix, never a URL to fetch (ruling R18).
     */
    onOverlongLoc: (entry: "url" | "sitemap", kept: string) => void;
    drain: () => Promise<void>;
  },
): Promise<SitemapStreamResult> {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(opts.charset ?? "utf-8", { fatal: false });
  } catch (error) {
    if (error instanceof RangeError) {
      await release(body);
      return { kind: "refused", reason: `refused: unknown charset label "${opts.charset}"` };
    }
    throw error;
  }

  let kind: "urlset" | "index" | null = null;
  let refusal: string | null = null;
  let rootClosed = false;
  // Set once the stream has ended: whatever `end()` closes was cut off.
  // (htmlparser2's `isImplied` cannot tell this apart: in XML mode it is also
  // true for every self-closing tag.)
  let ended = false;
  let malformedEntries = 0;

  // Open elements, the root counting as 1: an entry is depth 2, its fields 3.
  let depth = 0;
  let inEntry = false;
  let field: FieldState | null = null;
  let loc = emptyField(LOC_TEXT_MAX);
  let lastmod = emptyField(LASTMOD_TEXT_MAX);
  let alternates: { hreflang: string; href: string }[] = [];
  let alternatesCapped = 0;

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
            loc = emptyField(LOC_TEXT_MAX);
            lastmod = emptyField(LASTMOD_TEXT_MAX);
            alternates = [];
            alternatesCapped = 0;
          }
          return;
        }
        if (!inEntry) return;
        if (depth === 3) {
          if (local === "loc") field = loc;
          else if (local === "lastmod") field = lastmod;
          else field = null;
          if (field !== null) field.count++;
          if (local === "link" && kind === "urlset") {
            const rel = attribs["rel"]?.trim().toLowerCase();
            const hreflang = attribs["hreflang"];
            const href = attribs["href"];
            if (rel && rel.split(/\s+/).includes("alternate") && hreflang && href !== undefined) {
              if (alternates.length < MAX_HREFLANG_PAIRS) alternates.push({ hreflang, href });
              else alternatesCapped++;
            }
          }
          return;
        }
        if (depth === 4 && field !== null) field.hasElement = true;
      },
      ontext(text) {
        if (ignoring()) return;
        if (depth === 3 && field !== null) appendFieldText(field, text);
      },
      onclosetag() {
        if (ignoring()) return;
        if (depth === 3) {
          field = null;
        } else if (depth === 2 && inEntry) {
          inEntry = false;
          if (!ended && loc.count === 1 && !loc.hasElement && loc.overflow) {
            opts.onOverlongLoc(kind === "urlset" ? "url" : "sitemap", loc.text);
            depth--;
            return;
          }
          const locValue = ended ? null : fieldValue(loc);
          if (locValue === null) {
            malformedEntries++;
          } else if (kind === "urlset") {
            opts.onUrl({ loc: locValue, lastmod: fieldValue(lastmod), alternates, alternatesCapped });
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
    // end() closes every open element. An entry it closes was cut off by the
    // end of the stream: malformed, never emitted (see `ended`). Not called on
    // the oversized path, where the cut entry is simply left unread.
    ended = true;
    parser.end();
    if (refusal !== null) return { kind: "refused", reason: refusal };
    await opts.drain();
  }

  if (kind === null) return { kind: "refused", reason: ROOT_REASON };
  return { kind, bytes, oversized, malformedEntries };
}

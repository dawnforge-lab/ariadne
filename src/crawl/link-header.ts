/**
 * The HTTP `Link` header (RFC 8288 §3), tokenized.
 *
 *   Link       = #link-value
 *   link-value = "<" URI-Reference ">" *( OWS ";" OWS link-param )
 *   link-param = token BWS [ "=" BWS ( token / quoted-string ) ]
 *
 * A real tokenizer rather than `split(",")`, because a comma is legal in two
 * places a split cannot see: inside the `<…>` URI (`<https://x/a,b>`) and
 * inside a quoted parameter value (`title="a, b"`). Splitting there turns one
 * alternate into two broken ones, and the hreflang it declared disappears.
 *
 * Each header VALUE is read on its own. Repeated `Link` fields are one list
 * (RFC 9110 §5.3), so the entries of every value are concatenated in arrival
 * order; reading them separately only stops a broken quote in one value from
 * swallowing the next.
 *
 * A malformed entry — no `<` where an entry starts, no closing `>`, an
 * unterminated quote, a parameter with no name, junk between parameters — is
 * skipped to the next comma outside a quoted string and COUNTED in
 * `malformed`, never silently dropped and never thrown: the header is the
 * site's text, and one bad entry must not cost the good ones beside it.
 * Lenient where servers commonly are: an empty parameter (a trailing or
 * doubled `;`) is ignored, and an empty unquoted value (`foo=`) reads as `""`.
 */

export interface LinkHeaderEntry {
  /** The URI between `<` and `>`, verbatim and unresolved. */
  uri: string;
  /**
   * Parameter name (lower-cased) -> value: a quoted string unescaped, a token
   * as written, `""` for a parameter with no value. The first occurrence of a
   * name wins (RFC 8288 §3.3 for `rel`; applied to every name). `rel` keeps its
   * value's case; compare its tokens with `relTokens`.
   */
  params: Record<string, string>;
}

export interface ParsedLinkHeader {
  entries: LinkHeaderEntry[];
  /** Entries skipped because they could not be read. */
  malformed: number;
}

/** RFC 9110 §5.6.2 `tchar`. */
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;
const OWS = /[ \t]/;

/** Every entry in `values`, in order, and how many could not be read. */
export function parseLinkHeader(values: string[]): ParsedLinkHeader {
  const entries: LinkHeaderEntry[] = [];
  let malformed = 0;
  for (const value of values) {
    let i = 0;
    for (;;) {
      // Empty list elements (`a, , b`) are legal and are not entries.
      while (i < value.length && (OWS.test(value[i]!) || value[i] === ",")) i += 1;
      if (i >= value.length) break;
      const read = readEntry(value, i);
      if (read.entry === null) {
        malformed += 1;
        i = skipToNextEntry(value, read.end);
      } else {
        entries.push(read.entry);
        i = read.end;
      }
    }
  }
  return { entries, malformed };
}

/** The space-separated tokens of an entry's `rel`, lower-cased. */
export function relTokens(entry: LinkHeaderEntry): string[] {
  const rel = entry.params["rel"];
  if (rel === undefined) return [];
  return rel.toLowerCase().split(/\s+/).filter((token) => token !== "");
}

/**
 * One entry starting at `start` (which is not whitespace or a comma). On
 * success `end` is just past the entry; on failure it is where reading
 * stopped, for `skipToNextEntry` to carry on from.
 */
function readEntry(value: string, start: number): { entry: LinkHeaderEntry | null; end: number } {
  if (value[start] !== "<") return { entry: null, end: start };
  const close = value.indexOf(">", start + 1);
  if (close === -1) return { entry: null, end: value.length };
  const uri = value.slice(start + 1, close).trim();
  const params: Record<string, string> = {};
  let i = close + 1;
  for (;;) {
    while (i < value.length && OWS.test(value[i]!)) i += 1;
    if (i >= value.length || value[i] === ",") return { entry: { uri, params }, end: i };
    if (value[i] !== ";") return { entry: null, end: i };
    i += 1;
    while (i < value.length && OWS.test(value[i]!)) i += 1;
    // An empty parameter (`rel="canonical";`, `a;;b`) is a no-op, not a
    // malformed entry: trailing semicolons are common in hand-written server
    // configs, and refusing them would lose the site's canonical.
    if (i >= value.length || value[i] === "," || value[i] === ";") continue;

    const nameStart = i;
    while (i < value.length && TCHAR.test(value[i]!)) i += 1;
    if (i === nameStart) return { entry: null, end: i };
    const name = value.slice(nameStart, i).toLowerCase();
    while (i < value.length && OWS.test(value[i]!)) i += 1;

    let paramValue = "";
    if (value[i] === "=") {
      i += 1;
      while (i < value.length && OWS.test(value[i]!)) i += 1;
      if (value[i] === '"') {
        const quoted = readQuoted(value, i);
        if (quoted === null) return { entry: null, end: value.length };
        paramValue = quoted.text;
        i = quoted.end;
      } else {
        // A token by the grammar. Read up to the next delimiter rather than
        // stopping at the first non-tchar, so an unquoted `anchor=/a/b` is
        // read whole instead of being called malformed. An empty one
        // (`foo=`) is read as `""`, like a parameter with no `=`.
        const valueStart = i;
        while (i < value.length && !/[;,\s]/.test(value[i]!)) i += 1;
        paramValue = value.slice(valueStart, i);
      }
    }
    if (!Object.hasOwn(params, name)) params[name] = paramValue;
  }
}

/** A quoted-string at `start` (the opening `"`), unescaped, or null if it never closes. */
function readQuoted(value: string, start: number): { text: string; end: number } | null {
  let text = "";
  for (let i = start + 1; i < value.length; i += 1) {
    const c = value[i]!;
    if (c === "\\") {
      i += 1;
      if (i >= value.length) return null;
      text += value[i];
    } else if (c === '"') {
      return { text, end: i + 1 };
    } else {
      text += c;
    }
  }
  return null;
}

/** Past the next comma that is not inside a quoted string, or the end. */
function skipToNextEntry(value: string, from: number): number {
  let inQuote = false;
  for (let i = from; i < value.length; i += 1) {
    const c = value[i];
    if (inQuote) {
      if (c === "\\") i += 1;
      else if (c === '"') inQuote = false;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ",") {
      return i + 1;
    }
  }
  return value.length;
}

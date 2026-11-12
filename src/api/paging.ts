/**
 * The surface's pagination helpers — the page size, `parseLimit` and the
 * opaque cursor — in a module of its own so a listing outside the service (the
 * crawl events, src/events/events.ts) pages exactly as the service's listings
 * do without importing the service (`errors.ts`'s reason). The shape itself,
 * `Page<T>`, stays declared in `service.ts` with the other response shapes.
 * `service.ts` re-exports the page sizes, so every transport and test keeps
 * importing them from where they always have.
 */
import { ServiceError, clip } from "./errors.js";

/** Rows per page when the caller does not say, and the ceiling when they do. */
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

/**
 * A listing cursor: the sort key of the last row returned, base64url-encoded so
 * it is opaque to the caller and one token rather than three query parameters.
 *
 * Opaque, not encrypted — it carries values the caller was just given. What it
 * must not be is *guessable in the wrong shape*: a cursor that does not decode
 * is a 400, never an empty page, because an agent that paginated into silence
 * would conclude the listing had ended.
 *
 * JSON-encoded rather than delimiter-joined, because the parts are no longer
 * timestamps and ids: a URL may contain the delimiter, and so may a dedupe key
 * built from one. A cursor that split in the wrong place would page from a
 * position nobody asked for — silently, and only for the sites whose URLs
 * happen to contain the character.
 */
export function encodeCursor(...parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

// Overloaded by arity so a caller destructures a TUPLE rather than an array of
// possibly-undefined parts: the arity check below is what makes that safe, and
// the type says so instead of every call site restating it.
export function decodeCursor(cursor: string, arity: 1): [string];
export function decodeCursor(cursor: string, arity: 2): [string, string];
export function decodeCursor(cursor: string, arity: 3): [string, string, string];
export function decodeCursor(cursor: string, arity: number): string[] {
  const bad = (): never => {
    throw new ServiceError("VALIDATION", "cursor is not a cursor this server issued");
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return bad();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== arity ||
    parsed.some((part) => typeof part !== "string")
  ) {
    return bad();
  }
  return parsed as string[];
}

export function parseLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_SIZE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) {
    throw new ServiceError(
      "VALIDATION",
      `limit must be an integer between 1 and ${PAGE_SIZE_MAX}, got ${clip(String(limit))}`,
    );
  }
  return limit;
}

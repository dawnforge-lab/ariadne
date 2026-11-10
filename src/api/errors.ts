/**
 * The service layer's refusal type, in a module of its own so the helpers the
 * service is built from (`judgement-view.ts`) can raise one without importing
 * the service — `service.ts` re-exports both names, so every transport and test
 * keeps importing them from where they always have.
 */

/**
 * The ways a request can be refused for a reason the caller can act on. A
 * transport maps these; nothing else in this module knows they become 400,
 * 403, 404 and 409 (`CREDENTIALS_REQUIRED` is a 409 too).
 *
 * The code travels beside the sentence on both transports — `{error, code}`
 * over HTTP and in MCP's JSON error (27c Deviation 10) — so an agent tells
 * `CREDENTIALS_REQUIRED` from any other 409 without parsing the sentence.
 * `CREDENTIALS_REQUIRED`: a crawl whose stored shape says it needs credentials
 * was asked to run without them (after a restart the in-memory credentials
 * are gone); re-supply them.
 */
export type ServiceErrorCode =
  | "VALIDATION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CREDENTIALS_REQUIRED";

/**
 * A refusal with a reason the caller may be shown.
 *
 * Every message raised as a `ServiceError` is tenant-safe by construction: it
 * is built from crawl ids, field names, statuses, counts and URL-policy reasons
 * — never from a stack, a file path or an internal hostname (Talos obligation
 * 6). Anything that is NOT a `ServiceError` is a defect, and the transport
 * turns it into a 500 with a correlation id, keeping the detail in the log.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * Bound and de-fang a caller's own string before it goes back in an error.
 *
 * Not an escaping function — the response is JSON, which quotes for us — but a
 * length and control-character cap, so a 10MB value or a terminal escape
 * sequence cannot ride an error message into somebody's log or console.
 *
 * Not redaction either: it is for VALUES a caller asked about (a URL, an id).
 * A KEY the caller sent is never quoted at all, clipped or not — it is named
 * by its position (`unknownKeyMessage`, 27d spec §4).
 */
export function clip(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

/**
 * The accepted name closest to `sent`, or null: case-insensitive
 * Damerau-Levenshtein (optimal string alignment) distance at most 2, ties
 * going to the first in `accepted`.
 *
 * The suggestion is ALWAYS one of `accepted` — our own vocabulary — so naming
 * it repeats nothing the caller sent. A name whose length differs from `sent`
 * by more than 2 is skipped before any table is built, so a megabyte key costs
 * one length comparison per accepted name, not a megabyte-sized table.
 */
export function nearestAccepted(sent: string, accepted: readonly string[]): string | null {
  const a = sent.toLowerCase();
  let best: string | null = null;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const name of accepted) {
    const b = name.toLowerCase();
    if (Math.abs(a.length - b.length) > MAX_SUGGESTION_DISTANCE) continue;
    const distance = osaDistance(a, b);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

const MAX_SUGGESTION_DISTANCE = 2;

/** Optimal-string-alignment distance: insert, delete, substitute, swap two neighbours. */
function osaDistance(a: string, b: string): number {
  const cols = b.length + 1;
  const d = new Array<number>((a.length + 1) * cols).fill(0);
  const at = (i: number, j: number): number => d[i * cols + j] as number;
  for (let i = 0; i <= a.length; i++) d[i * cols] = i;
  for (let j = 0; j <= b.length; j++) d[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, at(i - 2, j - 2) + 1);
      }
      d[i * cols + j] = value;
    }
  }
  return at(a.length, b.length);
}

/**
 * The words after "unknown field" (or "unknown query parameter"): the key's
 * POSITION, 1-based in the order sent (`Object.keys` order), the accepted name
 * it most likely meant, and the accepted list. `others` counts the unknown
 * keys after it, for a refusal that names only the first.
 *
 * Never contains `sent` (27d spec §4): a key can be a secret pasted into the
 * wrong place, and a 400 must not hand it back — to the caller's console, a
 * proxy's log, or whoever reads the agent's transcript.
 */
function positionalClause(position: number, sent: string, accepted: readonly string[], others: number): string {
  const more = others > 0 ? ` (and ${others} more)` : "";
  const nearest = nearestAccepted(sent, accepted);
  const hint = nearest === null ? "." : `; did you mean '${nearest}'?`;
  const list = accepted.length === 0 ? "" : ` Accepted: ${accepted.join(", ")}`;
  return `(key ${position} in the order sent)${more}${hint}${list}`;
}

/**
 * "<path> has an unknown field (key <position> in the order sent); did you
 * mean '<nearest>'? Accepted: a, b, c" — the "did you mean" clause only when
 * `nearestAccepted` is non-null; `<path>` is "body" at the top level. `others`
 * adds "(and N more)" after the position. Never contains `sent`.
 */
export function unknownKeyMessage(
  path: string,
  position: number,
  sent: string,
  accepted: readonly string[],
  others = 0,
): string {
  return `${path} has an unknown field ${positionalClause(position, sent, accepted, others)}`;
}

/**
 * `unknownKeyMessage` less its "<path> has an" lead, for a refusal written as
 * "<path>: <detail>" (the judgement block's sentences, `parseJudgement`).
 */
export function unknownKeyDetail(position: number, sent: string, accepted: readonly string[], others = 0): string {
  return `unknown field ${positionalClause(position, sent, accepted, others)}`;
}

/** An unknown query parameter, named by its position among the parameters sent. */
export function unknownQueryParameterMessage(position: number, sent: string, accepted: readonly string[]): string {
  return accepted.length === 0
    ? `unknown query parameter (key ${position} in the order sent): this route takes none`
    : `unknown query parameter ${positionalClause(position, sent, accepted, 0)}`;
}

/**
 * A key's 1-based position among `container`'s own enumerable keys, in the
 * order sent. A key that is not one is a defect in the caller, and throws.
 */
export function positionOf(container: unknown, key: string): number {
  if (container === null || typeof container !== "object") {
    throw new Error("positionOf: the container is not an object");
  }
  const at = Object.keys(container).indexOf(key);
  if (at === -1) throw new Error("positionOf: the key is not one of the container's own keys");
  return at + 1;
}

/**
 * The first of `unknown` — keys of `input` a strict schema refused — as
 * `unknownKeyMessage` names it, counting the rest.
 */
export function unknownKeysMessage(
  path: string,
  input: unknown,
  unknown: readonly string[],
  accepted: readonly string[],
): string {
  const first = unknown[0];
  if (first === undefined) throw new Error(`unknownKeysMessage: no unknown key at ${path}`);
  return unknownKeyMessage(path, positionOf(input, first), first, accepted, unknown.length - 1);
}

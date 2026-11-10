/**
 * The MCP tools' input schemas (Phase 27d, spec §4).
 *
 * The MCP SDK validates a tool's arguments against its input schema BEFORE the
 * handler runs, and answers a refusal with each zod issue's `message` (plus
 * ` at <path>` when the issue has one). zod's own message for an unknown key
 * quotes it — `Unrecognized key: "sk_live_…"` — so a secret pasted as an
 * argument name would come straight back in the tool error. `strictInput` is
 * `z.strictObject` with that one message replaced: the first unknown key by
 * its POSITION in the order sent, the accepted argument it most likely meant,
 * and the accepted list (`unknownKeyMessage`). A top-level unknown key's issue
 * has an empty path, so the SDK appends nothing to it.
 *
 * Every other issue keeps zod's message: those name an argument this schema
 * declares, or a value, never a key the caller invented. A record-keyed
 * argument whose keys name things takes `z.unknown()` values (or none) so no
 * sent key ever lands in an issue's path.
 */
import { z } from "zod";

import { unknownKeysMessage } from "./errors.js";

/** A tool's arguments: a strict object whose unknown-key refusal never quotes the key. */
export function strictInput<T extends z.ZodRawShape>(shape: T) {
  const accepted = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? unknownKeysMessage("body", issue.input, issue.keys, accepted)
        : undefined,
  });
}

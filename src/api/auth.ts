/**
 * Bearer-token authentication for the HTTP surface.
 *
 * One function, applied to EVERY route before routing — including routes that
 * do not exist. An unauthenticated caller learns whether the server is up and
 * nothing else: a 404 handed out before the token is checked would map the
 * surface for anyone who asked.
 *
 * (The MCP transport does not use this. Its callers reach the process over
 * stdio and are process-trusted; the domain allowlist binds both transports.
 * See `ApiServerConfig` in config.ts.)
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type AuthResult = { ok: true } | { ok: false; error: string };

/**
 * Check an `Authorization` header value against the configured token.
 *
 * The comparison is over SHA-256 digests rather than the raw strings, for one
 * reason that matters and one that is bookkeeping: `timingSafeEqual` throws on
 * length-mismatched buffers, so comparing raw tokens would either leak the
 * length through an early return or need a second branch to hide it — hashing
 * makes every comparison the same 32 bytes. The digest is not a secret store
 * (both sides are in memory anyway); it is a length normaliser with a
 * constant-time comparison behind it.
 *
 * Every refusal names WHICH thing was wrong — missing, wrong scheme, wrong
 * token. That distinction is useful to an operator wiring up a client and
 * useless to an attacker, who already knows whether they sent a header.
 */
export function checkBearer(header: string | undefined, token: string): AuthResult {
  if (header === undefined || header.trim() === "") {
    return { ok: false, error: "missing Authorization header (expected: Bearer <token>)" };
  }
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) {
    return {
      ok: false,
      error: "unsupported Authorization scheme (expected: Bearer <token>)",
    };
  }
  const presented = match[1] ?? "";
  return sameSecret(presented.trim(), token)
    ? { ok: true }
    : { ok: false, error: "invalid API token" };
}

function sameSecret(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

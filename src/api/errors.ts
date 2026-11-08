/**
 * The service layer's refusal type, in a module of its own so the helpers the
 * service is built from (`judgement-view.ts`) can raise one without importing
 * the service — `service.ts` re-exports both names, so every transport and test
 * keeps importing them from where they always have.
 */

/**
 * The four ways a request can be refused for a reason the caller can act on.
 * A transport maps these; nothing else in this module knows they become 400,
 * 403, 404 and 409.
 */
export type ServiceErrorCode = "VALIDATION" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

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
 * length and control-character cap, so a 10MB field name or a terminal escape
 * sequence cannot ride an error message into somebody's log or console.
 */
export function clip(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

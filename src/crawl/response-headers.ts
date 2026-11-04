/**
 * The response headers a page row keeps (`pages.response_headers`, migration 0025).
 *
 * A fixed allowlist, grown only when a check needs a header: headers off the list
 * are neither stored nor counted. Per-row data flowing through the existing
 * writer; nothing here accumulates across pages (hard rule 6).
 */
import type { HeaderBag } from "./http.js";

export const RESPONSE_HEADER_ALLOWLIST: readonly string[] = [
  // security
  "strict-transport-security",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  // cache
  "cache-control",
  "expires",
  "etag",
  "last-modified",
  "age",
  "vary",
  // content
  "content-type",
  "content-language",
  "content-encoding",
  // directives
  "x-robots-tag",
  "link",
  // platform hints
  "server",
  "x-powered-by",
];

/** Per-value cap, in characters. Long enough for a real CSP's directive list. */
export const RESPONSE_HEADER_VALUE_CAP = 2048;

export interface StoredResponseHeaders {
  /** Lower-cased allowlisted name -> every occurrence, in arrival order. */
  values: Record<string, string[]>;
  /** Names with at least one value cut at the cap: a cut value is never mistaken for a whole one. */
  truncated: string[];
}

const ALLOWED = new Set(RESPONSE_HEADER_ALLOWLIST);

export function captureResponseHeaders(headers: HeaderBag): StoredResponseHeaders {
  const values: Record<string, string[]> = {};
  const truncated: string[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (!ALLOWED.has(name)) continue;
    const occurrences = Array.isArray(rawValue) ? rawValue : [rawValue];
    let cut = false;
    const kept = occurrences.map((value) => {
      if (value.length <= RESPONSE_HEADER_VALUE_CAP) return value;
      cut = true;
      return value.slice(0, RESPONSE_HEADER_VALUE_CAP);
    });
    values[name] = [...(values[name] ?? []), ...kept];
    if (cut && !truncated.includes(name)) truncated.push(name);
  }
  return { values, truncated };
}

/**
 * Credentials on the wire (Phase 27c): custom request headers, HTTP Basic auth
 * and cookies, sent ONLY to the crawl's own site family and NEVER stored.
 *
 * THE THREE RULES THIS MODULE EXISTS TO HOLD:
 *
 *  - **Only the site family is told.** `credentialHeadersFor` answers per
 *    request, from THAT request's own URL: `isSameOrigin(url, siteUrl)` (the
 *    host modulo `www.`, the same port, or the http → https upgrade) or
 *    nothing at all. Every request builder calls it once per request, every
 *    manual redirect hop included, so a hop that leaves the family drops them
 *    for that hop. An https site's credentials never ride a plain-http request:
 *    `isSameOrigin` refuses the downgrade.
 *  - **A value is never stored, logged or quoted.** What a crawl row carries is
 *    the `CredentialShape` — which fields were supplied and the header and
 *    cookie NAMES — never a value. `credentialError`'s messages name the field
 *    and the header or cookie NAME, never a value; `CredentialsMissingError`
 *    names the crawl and the field names. `CrawlConfig.credentials` is stripped
 *    by `storableConfig` and never read back by `parseStoredConfig`.
 *  - **A crawl that needed them is never run without them** (hard rule 7). A
 *    stored shape with no credentials, or credentials of another shape, throws
 *    `CredentialsMissingError` before the first request.
 *
 * Politeness and identity are not negotiable (rule 9): the names the engine
 * owns (`user-agent`, `accept`, …) are refused, so a credential can never
 * change the user agent, and nothing here touches pacing or robots.
 */
import { isSameOrigin } from "./parse/url-utils.js";

/** At most this many custom request headers. */
export const MAX_REQUEST_HEADERS = 20;
/** The byte limit (UTF-8) on a header value, a cookie value, a username and a password. */
export const MAX_CREDENTIAL_VALUE_BYTES = 1024;
/** At most this many cookies, sent as one `Cookie` header. */
export const MAX_COOKIES = 50;

/**
 * Header names a client may not set, compared lower-case. The engine owns the
 * first nine (identity, content negotiation, framing); `cookie` and
 * `authorization` have their own fields. Any name starting `proxy-` is refused
 * too (`isRefusedHeaderName`).
 */
export const REFUSED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "host",
  "user-agent",
  "accept",
  "accept-encoding",
  "content-length",
  "connection",
  "transfer-encoding",
  "te",
  "upgrade",
  "cookie",
  "authorization",
]);

export interface CrawlCredentials {
  requestHeaders?: Readonly<Record<string, string>>;
  httpAuth?: { username: string; password: string };
  cookies?: ReadonlyArray<{ name: string; value: string }>;
}

/**
 * What a crawl row stores about its credentials: which were supplied, and the
 * names. Header names are lower-cased (HTTP names are case-insensitive) and
 * both name lists are sorted, so two shapes compare by value.
 */
export interface CredentialShape {
  requestHeaderNames: string[];
  httpAuth: boolean;
  cookieNames: string[];
}

/** What a request builder is handed: the values, and the site they belong to. */
export interface CredentialTarget {
  siteUrl: string;
  values: CrawlCredentials;
}

/** The shape of `c`, or null when nothing was supplied. */
export function shapeOf(c: CrawlCredentials): CredentialShape | null {
  const requestHeaderNames = Object.keys(c.requestHeaders ?? {})
    .map((name) => name.toLowerCase())
    .sort();
  const cookieNames = (c.cookies ?? []).map((cookie) => cookie.name).sort();
  const httpAuth = c.httpAuth !== undefined;
  if (requestHeaderNames.length === 0 && cookieNames.length === 0 && !httpAuth) return null;
  return { requestHeaderNames, httpAuth, cookieNames };
}

/** Whether two shapes (either possibly absent) describe the same credentials. */
export function sameShape(
  a: CredentialShape | null | undefined,
  b: CredentialShape | null | undefined,
): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  const names = (list: readonly string[], lower: boolean) =>
    [...list].map((n) => (lower ? n.toLowerCase() : n)).sort();
  const equal = (p: string[], q: string[]) =>
    p.length === q.length && p.every((value, i) => value === q[i]);
  return (
    x.httpAuth === y.httpAuth &&
    equal(names(x.requestHeaderNames, true), names(y.requestHeaderNames, true)) &&
    equal(names(x.cookieNames, false), names(y.cookieNames, false))
  );
}

/**
 * The credential headers for ONE request: `{}` unless `url` is in `siteUrl`'s
 * site family (`isSameOrigin`); else the custom headers as given, an
 * `authorization: Basic …` when `httpAuth` was supplied, and one
 * `cookie: n1=v1; n2=v2` when cookies were.
 *
 * Call it with the URL of the request about to be sent — never the crawl's
 * seed, never the first hop of a chain — so every hop is decided on its own.
 */
export function credentialHeadersFor(
  url: string,
  siteUrl: string,
  c: CrawlCredentials | undefined,
): Record<string, string> {
  if (c === undefined || !isSameOrigin(url, siteUrl)) return {};
  // `Object.fromEntries` defines own properties, so a header named
  // `__proto__` stays a header rather than becoming a prototype.
  const entries: Array<[string, string]> = Object.entries(c.requestHeaders ?? {});
  if (c.httpAuth !== undefined) {
    const token = Buffer.from(`${c.httpAuth.username}:${c.httpAuth.password}`, "utf8").toString(
      "base64",
    );
    entries.push(["authorization", `Basic ${token}`]);
  }
  if (c.cookies !== undefined && c.cookies.length > 0) {
    entries.push(["cookie", c.cookies.map(({ name, value }) => `${name}=${value}`).join("; ")]);
  }
  return Object.fromEntries(entries);
}

/** The `credentialHeadersFor` of a builder's optional `credentials` option. */
export function credentialHeadersOf(
  url: string,
  target: CredentialTarget | undefined,
): Record<string, string> {
  return target === undefined ? {} : credentialHeadersFor(url, target.siteUrl, target.values);
}

/** RFC 9110 §5.6.2 `token`: one or more tchars. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isRefusedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return REFUSED_HEADER_NAMES.has(lower) || lower.startsWith("proxy-");
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A name, quoted for a message. Names are not secrets; values are, and never get here. */
function quoted(name: string): string {
  return JSON.stringify(name);
}

/**
 * Why `c` is not a valid credential set, or null when it is.
 *
 * The message names the field (`path` is the caller's own prefix, e.g.
 * `crawl` or `CrawlConfig.credentials`) and the header or cookie NAME. It
 * NEVER contains a value — not a header value, not a username or password,
 * not a cookie value — whatever the reason for the refusal.
 *
 * Header values must be at most `MAX_CREDENTIAL_VALUE_BYTES` with no CR, LF or
 * NUL; any other control character but HTAB, and any character past U+00FF,
 * is refused as well, because the HTTP client refuses them at send time and a
 * crawl that fails on its first request is a worse place to learn it.
 */
export function credentialError(c: unknown, path: string): string | null {
  if (!isPlainObject(c)) return `${path} must be an object`;
  for (const key of Object.keys(c)) {
    if (key !== "requestHeaders" && key !== "httpAuth" && key !== "cookies") {
      return `${path} has an unknown field ${quoted(key)}`;
    }
  }
  return (
    headersError(c["requestHeaders"], `${path}.requestHeaders`) ??
    httpAuthError(c["httpAuth"], `${path}.httpAuth`) ??
    cookiesError(c["cookies"], `${path}.cookies`)
  );
}

function headersError(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) return `${path} must be an object of header name to string value`;
  const names = Object.keys(value);
  if (names.length > MAX_REQUEST_HEADERS) {
    return `${path} holds ${names.length} headers; the limit is ${MAX_REQUEST_HEADERS}`;
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (!TOKEN.test(name)) {
      return `${path} header name ${quoted(name)} is not an HTTP token (RFC 9110)`;
    }
    if (isRefusedHeaderName(name)) {
      const lower = name.toLowerCase();
      const why =
        lower === "cookie"
          ? "send cookies through the cookies field"
          : lower === "authorization"
            ? "send Basic credentials through the httpAuth field"
            : lower.startsWith("proxy-")
              ? "proxy headers are never sent"
              : "the engine owns it";
      return `${path} header name ${quoted(name)} is refused: ${why}`;
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      return `${path} names the header ${quoted(name)} twice (header names are case-insensitive)`;
    }
    seen.add(lower);
    const headerValue = value[name];
    if (typeof headerValue !== "string") {
      return `${path} header ${quoted(name)} value must be a string`;
    }
    if (bytes(headerValue) > MAX_CREDENTIAL_VALUE_BYTES) {
      return `${path} header ${quoted(name)} value is longer than ${MAX_CREDENTIAL_VALUE_BYTES} bytes`;
    }
    if (/[\r\n\0]/.test(headerValue)) {
      return `${path} header ${quoted(name)} value contains CR, LF or NUL`;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x01-\x08\x0a-\x1f\x7f]|[^\x00-\xff]/.test(headerValue)) {
      return (
        `${path} header ${quoted(name)} value contains a control character or a ` +
        `character past U+00FF, which an HTTP header cannot carry`
      );
    }
  }
  return null;
}

function httpAuthError(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) return `${path} must be an object with username and password`;
  for (const key of Object.keys(value)) {
    if (key !== "username" && key !== "password") {
      return `${path} has an unknown field ${quoted(key)}`;
    }
  }
  for (const field of ["username", "password"] as const) {
    const v = value[field];
    if (typeof v !== "string") return `${path}.${field} must be a string`;
    if (bytes(v) > MAX_CREDENTIAL_VALUE_BYTES) {
      return `${path}.${field} is longer than ${MAX_CREDENTIAL_VALUE_BYTES} bytes`;
    }
  }
  if ((value["username"] as string).includes(":")) {
    return `${path}.username contains ':', which Basic auth cannot carry in a username (RFC 7617)`;
  }
  return null;
}

/** RFC 6265 cookie-octets, without DQUOTE's special case: printable ASCII but `;` and `,`. */
const COOKIE_VALUE = /^[\x21-\x2b\x2d-\x3a\x3c-\x7e]*$/;

function cookiesError(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${path} must be an array of {name, value}`;
  if (value.length > MAX_COOKIES) {
    return `${path} holds ${value.length} cookies; the limit is ${MAX_COOKIES}`;
  }
  const seen = new Set<string>();
  for (const [i, cookie] of value.entries()) {
    if (!isPlainObject(cookie)) return `${path}[${i}] must be an object {name, value}`;
    for (const key of Object.keys(cookie)) {
      if (key !== "name" && key !== "value") {
        return `${path}[${i}] has an unknown field ${quoted(key)}`;
      }
    }
    const name = cookie["name"];
    if (typeof name !== "string") return `${path}[${i}].name must be a string`;
    if (!TOKEN.test(name)) {
      return `${path} cookie name ${quoted(name)} is not an HTTP token (RFC 6265)`;
    }
    if (seen.has(name)) return `${path} names the cookie ${quoted(name)} twice`;
    seen.add(name);
    const cookieValue = cookie["value"];
    if (typeof cookieValue !== "string") {
      return `${path} cookie ${quoted(name)} value must be a string`;
    }
    if (bytes(cookieValue) > MAX_CREDENTIAL_VALUE_BYTES) {
      return `${path} cookie ${quoted(name)} value is longer than ${MAX_CREDENTIAL_VALUE_BYTES} bytes`;
    }
    if (!COOKIE_VALUE.test(cookieValue)) {
      return (
        `${path} cookie ${quoted(name)} value contains ';', ',', whitespace, a control ` +
        `character or a non-ASCII character, none of which a Cookie header can carry`
      );
    }
  }
  return null;
}

/**
 * Why a stored or supplied `credentialShape` is not one, or null. A shape is
 * data we wrote, but it has been through a jsonb column, so it is validated
 * rather than trusted (the `parseStoredConfig` precedent).
 */
export function credentialShapeError(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} is not an object`;
  const { requestHeaderNames, httpAuth, cookieNames } = value;
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((entry) => typeof entry === "string");
  if (!strings(requestHeaderNames)) return `${path}.requestHeaderNames is not an array of strings`;
  if (typeof httpAuth !== "boolean") return `${path}.httpAuth is not a boolean`;
  if (!strings(cookieNames)) return `${path}.cookieNames is not an array of strings`;
  // `shapeOf` answers null for "nothing supplied", never an empty shape: one
  // that names nothing would demand credentials it cannot describe.
  if (
    (requestHeaderNames as string[]).length === 0 &&
    (cookieNames as string[]).length === 0 &&
    !httpAuth
  ) {
    return `${path} names no credentials; omit it instead`;
  }
  return null;
}

function describeShape(shape: CredentialShape): string {
  const parts: string[] = [];
  if (shape.requestHeaderNames.length > 0) {
    parts.push(`requestHeaders (${shape.requestHeaderNames.join(", ")})`);
  }
  if (shape.httpAuth) parts.push("httpAuth");
  if (shape.cookieNames.length > 0) parts.push(`cookies (${shape.cookieNames.join(", ")})`);
  return parts.join(", ");
}

/**
 * A crawl whose stored shape says it needs credentials was asked to run without
 * them, or with credentials of another shape. Thrown before the first request
 * (hard rule 7): a crawl never continues unauthenticated against a site that
 * needed auth, which would quietly turn every page into a 401 row.
 *
 * The message names the crawl and the field and header/cookie NAMES only.
 */
export class CredentialsMissingError extends Error {
  readonly crawlId: string | null;
  readonly required: CredentialShape;
  readonly supplied: CredentialShape | null;
  constructor(
    crawlId: string | null,
    siteUrl: string,
    required: CredentialShape,
    supplied: CredentialShape | null,
  ) {
    const crawl = crawlId === null ? `a new crawl of ${siteUrl}` : `crawl ${crawlId}`;
    super(
      supplied === null
        ? `${crawl} needs credentials it was not given: ${describeShape(required)}. ` +
            `Supply them again; a crawl that needed them is never run without them`
        : `${crawl} needs credentials of another shape: it needs ${describeShape(required)}, ` +
            `and was given ${describeShape(supplied)}`,
    );
    this.name = "CredentialsMissingError";
    this.crawlId = crawlId;
    this.required = required;
    this.supplied = supplied;
  }
}

/**
 * Throws `CredentialsMissingError` when `required` is a shape and `credentials`
 * are absent or of another shape. A null `required` asks for nothing.
 */
export function requireCredentials(
  crawlId: string | null,
  siteUrl: string,
  required: CredentialShape | null | undefined,
  credentials: CrawlCredentials | undefined,
): void {
  if (required === null || required === undefined) return;
  const supplied = credentials === undefined ? null : shapeOf(credentials);
  if (!sameShape(required, supplied)) {
    throw new CredentialsMissingError(crawlId, siteUrl, required, supplied);
  }
}

/**
 * Credentials on the wire (Phase 27c): custom request headers, HTTP Basic auth
 * and cookies, sent ONLY to the crawl's own site family and NEVER stored in
 * clear (Phase 28b: the vault keeps them encrypted, src/crawl/credential-vault.ts).
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
 *  - **A value is never stored in clear, logged or quoted.** What a crawl row carries is
 *    the `CredentialShape` — which fields were supplied and the header and
 *    cookie NAMES — never a value. `credentialError`'s messages name the field
 *    and the header or cookie NAME, never a value — and a name that is not an
 *    HTTP token, or an unknown key, by its POSITION only, never quoted, since
 *    a mis-shaped name is where a misplaced value lands; `CredentialsMissingError`
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
 * `authorization` have their own fields. `expect` and `keep-alive` are refused
 * because undici refuses to send either (it throws at send time), so a crawl
 * carrying one would fail on its first request — refused at validation
 * instead (27c T8). Any name starting `proxy-` or `sec-` is refused too
 * (`isRefusedHeaderName`): the Fetch standard's forbidden prefixes. `sec-*`
 * names are the browser's own (`sec-ch-ua*`, its identity hints, and
 * `sec-fetch-*`), which a credential header would otherwise replace in the
 * render pass (27c final wave M5).
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
  "expect",
  "keep-alive",
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

/** The name prefixes a client may not use, compared lower-case (the Fetch standard's forbidden prefixes). */
export const REFUSED_HEADER_PREFIXES: readonly string[] = ["proxy-", "sec-"];

function isRefusedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    REFUSED_HEADER_NAMES.has(lower) ||
    REFUSED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * A name, quoted for a message. A well-formed name (an HTTP token) is not a
 * secret; values are, and never get here. A name that is NOT a token is never
 * quoted (27c final wave M13): the commonest misuse puts the value in the name
 * (`"session=S3CRET"`, `"Authorization: Bearer S3CRET"`), so a refusal names
 * its position instead.
 */
function quoted(name: string): string {
  return JSON.stringify(name);
}

const UNQUOTED = "it is not quoted, since a mis-shaped name may hold a value";

/**
 * Why an object's keys are not all `accepted`, or null. The first unknown key
 * is named by its position (from 1, in the order sent), never quoted: a key
 * can be a value pasted in the wrong place (27c final wave M13).
 */
function unknownKeyError(path: string, value: Record<string, unknown>, accepted: readonly string[]): string | null {
  const keys = Object.keys(value);
  const at = keys.findIndex((key) => !accepted.includes(key));
  if (at === -1) return null;
  return (
    `${path} has an unknown field (key ${at + 1} in the order sent; accepted: ` +
    `${accepted.join(", ")}); ${UNQUOTED}`
  );
}

/**
 * Why a header NAME is not one a client may set, or null; a good name is added
 * to `seen` (lower-cased: header names are case-insensitive). `position` names
 * it without quoting it (`requestHeaders entry 3`), for a name that is not a
 * token. Shared by the value validator and `credentialShapeError`.
 */
function headerNameError(name: string, path: string, position: string, seen: Set<string>): string | null {
  if (!TOKEN.test(name)) {
    return `${position} has a name that is not an HTTP token (RFC 9110); ${UNQUOTED}`;
  }
  const lower = name.toLowerCase();
  if (isRefusedHeaderName(name)) {
    const why =
      lower === "cookie"
        ? "send cookies through the cookies field"
        : lower === "authorization"
          ? "send Basic credentials through the httpAuth field"
          : lower.startsWith("proxy-")
            ? "proxy headers are never sent"
            : lower.startsWith("sec-")
              ? "sec-* headers are the browser's own (a forbidden prefix in the Fetch standard)"
              : lower === "expect" || lower === "keep-alive"
                ? "the HTTP client refuses to send it"
                : "the engine owns it";
    return `${path} header name ${quoted(name)} is refused: ${why}`;
  }
  if (seen.has(lower)) {
    return `${path} names the header ${quoted(name)} twice (header names are case-insensitive)`;
  }
  seen.add(lower);
  return null;
}

/** `headerNameError` for a cookie NAME (RFC 6265 cookie-name is a token; case-sensitive). */
function cookieNameError(name: string, path: string, position: string, seen: Set<string>): string | null {
  if (!TOKEN.test(name)) {
    return `${position} is not an HTTP token (RFC 6265); ${UNQUOTED}`;
  }
  if (seen.has(name)) return `${path} names the cookie ${quoted(name)} twice`;
  seen.add(name);
  return null;
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
  const unknown = unknownKeyError(path, c, ["requestHeaders", "httpAuth", "cookies"]);
  if (unknown !== null) return unknown;
  return (
    headersError(c["requestHeaders"], `${path}.requestHeaders`) ??
    httpAuthError(c["httpAuth"], `${path}.httpAuth`) ??
    cookiesError(c["cookies"], `${path}.cookies`)
  );
}

/**
 * `credentialError` for ONE of the three fields, as a request body carries it
 * at the top level (the API's start body, src/api/config-schema.ts). The
 * message leads with `path` — the field's own name unless the caller says
 * otherwise — and, like every message here, never contains a value. Absent
 * (`undefined`) is valid.
 */
export function credentialFieldError(
  field: keyof CrawlCredentials,
  value: unknown,
  path: string = field,
): string | null {
  switch (field) {
    case "requestHeaders":
      return headersError(value, path);
    case "httpAuth":
      return httpAuthError(value, path);
    case "cookies":
      return cookiesError(value, path);
  }
}

function headersError(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) return `${path} must be an object of header name to string value`;
  const names = Object.keys(value);
  if (names.length > MAX_REQUEST_HEADERS) {
    return `${path} holds ${names.length} headers; the limit is ${MAX_REQUEST_HEADERS}`;
  }
  const seen = new Set<string>();
  for (const [i, name] of names.entries()) {
    const nameError = headerNameError(name, path, `${path} entry ${i + 1}`, seen);
    if (nameError !== null) return nameError;
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
  const unknown = unknownKeyError(path, value, ["username", "password"]);
  if (unknown !== null) return unknown;
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
    const unknown = unknownKeyError(`${path}[${i}]`, cookie, ["name", "value"]);
    if (unknown !== null) return unknown;
    const name = cookie["name"];
    if (typeof name !== "string") return `${path}[${i}].name must be a string`;
    const nameError = cookieNameError(name, path, `${path}[${i}].name`, seen);
    if (nameError !== null) return nameError;
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
 * rather than trusted (the `parseStoredConfig` precedent): no unknown key,
 * and the names obey the rules the value validators apply — a header name is
 * a token, not refused and not repeated (case-insensitively), a cookie name a
 * token and not repeated (27c final wave M7). The same name checks, so the
 * same messages, never quoting a name that is not a token.
 */
export function credentialShapeError(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} is not an object`;
  const unknown = unknownKeyError(path, value, ["requestHeaderNames", "httpAuth", "cookieNames"]);
  if (unknown !== null) return unknown;
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
  const headerPath = `${path}.requestHeaderNames`;
  const headersSeen = new Set<string>();
  for (const [i, name] of (requestHeaderNames as string[]).entries()) {
    const error = headerNameError(name, headerPath, `${headerPath}[${i}]`, headersSeen);
    if (error !== null) return error;
  }
  const cookiePath = `${path}.cookieNames`;
  const cookiesSeen = new Set<string>();
  for (const [i, name] of (cookieNames as string[]).entries()) {
    const error = cookieNameError(name, cookiePath, `${cookiePath}[${i}]`, cookiesSeen);
    if (error !== null) return error;
  }
  return null;
}

/**
 * What a reader is shown in place of a credential value (27c T9): the
 * `crawl_config_get` view writes it for every value, and `crawl_config_set`
 * reads a field sent back exactly as that view showed it as "no change".
 * The same marker the `request_headers` evidence redaction writes.
 */
export const REDACTED = "[redacted]";

/**
 * The three credential fields as a reader sees them: the names the shape
 * stores, every value `REDACTED`. A field the shape does not name is absent.
 * Header names are the shape's (lower-cased); cookie names keep their case.
 */
export function redactedCredentials(shape: CredentialShape | null): {
  requestHeaders?: Record<string, string>;
  httpAuth?: string;
  cookies?: Array<{ name: string; value: string }>;
} {
  if (shape === null) return {};
  return {
    ...(shape.requestHeaderNames.length === 0
      ? {}
      : {
          // Own properties, so a header named `__proto__` stays a header.
          requestHeaders: Object.fromEntries(
            shape.requestHeaderNames.map((name) => [name, REDACTED] as const),
          ),
        }),
    ...(shape.httpAuth ? { httpAuth: REDACTED } : {}),
    ...(shape.cookieNames.length === 0
      ? {}
      : { cookies: shape.cookieNames.map((name) => ({ name, value: REDACTED })) }),
  };
}

/**
 * Why a credential field's value carries the `REDACTED` marker where a value
 * belongs, or null. A marker is what a reader was SHOWN, not a value: sent as
 * one, it would be a header, password or cookie literally reading
 * "[redacted]". Names the field (and the header or cookie NAME) only.
 */
export function redactionMarkerError(field: keyof CrawlCredentials, value: unknown): string | null {
  const marked = `carries the redaction marker '${REDACTED}' where a value belongs`;
  switch (field) {
    case "httpAuth":
      if (value === REDACTED) return `httpAuth ${marked}`;
      if (isPlainObject(value)) {
        for (const key of ["username", "password"] as const) {
          if (value[key] === REDACTED) return `httpAuth.${key} ${marked}`;
        }
      }
      return null;
    case "requestHeaders":
      if (isPlainObject(value)) {
        for (const [i, [name, v]] of Object.entries(value).entries()) {
          if (v !== REDACTED) continue;
          // A name that is not a token is named by position, never quoted (M13).
          const which = TOKEN.test(name) ? `header ${quoted(name)}` : `entry ${i + 1}`;
          return `requestHeaders ${which} ${marked}`;
        }
      }
      return null;
    case "cookies":
      if (Array.isArray(value)) {
        for (const [i, cookie] of value.entries()) {
          if (isPlainObject(cookie) && cookie["value"] === REDACTED) {
            const name = cookie["name"];
            const which =
              typeof name === "string" && TOKEN.test(name) ? ` (cookie ${quoted(name)})` : "";
            return `cookies[${i}]${which} ${marked}`;
          }
        }
      }
      return null;
  }
}

/** The fields and names a shape asks for, for a message: never a value. */
export function describeShape(shape: CredentialShape): string {
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

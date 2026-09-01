/**
 * The HTTP transport: `node:http`, a route table, and JSON in and out.
 *
 * There is no framework here on purpose (the phase plan's constraint). What a
 * framework would give us is what this file already is — six routes, one auth
 * check, one body reader and one error mapper — and what it would cost is a
 * dependency between an unattended agent and a database handle.
 *
 * The division of labour with `service.ts` is strict: **this file does routing,
 * authentication and serialisation, and nothing else.** It holds no SQL, makes
 * no policy decision, and does not know what a lease is. Every refusal it
 * writes is either its own (401, 405, 413, malformed JSON) or a `ServiceError`
 * whose code it maps to a status. When Task 4 mounts MCP over the same service,
 * nothing in this file is reused and nothing in it needs to be.
 *
 * ## The routes
 *
 *   POST /crawls                       accept a crawl (allowlist + URL policy) -> 202
 *   GET  /crawls                       list crawls, newest first, paginated.
 *                                      `?siteUrl=` narrows it to one site — the
 *                                      apex/www family, any scheme, any port
 *                                      (`listCrawls`) — which is the project
 *                                      history a date picker is built on
 *   GET  /crawls/:id                   one crawl: status, counts, frontier, timings
 *   POST /crawls/:id/fail              close a crawl nobody is working
 *   POST /crawls/:id/render            run the render pass. No body: the engine
 *                                      selects. `{"urls": [...]}`: those pages
 *                                      instead, replacing the automatic
 *                                      selection for that pass
 *   POST /crawls/:id/rules             run the rules
 *   GET  /crawls/:id/issues            findings grouped by rule (the triage view).
 *                                      A group's `count` is the rows the rule
 *                                      wrote; `truncated` + `total`|`atLeast`
 *                                      appear when the rule capped its listing,
 *                                      and their absence means the count is the
 *                                      whole number (see `listIssues`).
 *   GET  /crawls/:id/issues/:rule/urls one rule's findings, URL by URL
 *   GET  /crawls/:id/metrics           the measured numbers, with their copy
 *   GET  /crawls/:id/pages             the crawled pages, slim and filtered
 *   GET  /crawls/:id/robots            the site's robots.txt as this crawl read it
 *   GET  /rules                        the rule catalog: every rule with its
 *                                      client-facing copy. `?crawlId=` joins
 *                                      one crawl's fired state onto it —
 *                                      `{count}` on a judged crawl (0 is a real
 *                                      value) and `null` on one nobody judged.
 *                                      `atLeast: true` beside a count means the
 *                                      rule capped its listing, so the count is
 *                                      a floor and the magnitude is on the
 *                                      issues route. `measuresOnly: true` marks
 *                                      a metric rule, whose 0 is structural —
 *                                      it measures rather than finds and writes
 *                                      no issues at all (see `RuleFired`)
 *   GET  /crawls/:id/export            write a dataset to disk, answer with the path
 *   GET  /compare                      two crawls of one site, rule by rule:
 *                                      counts on both sides plus new/resolved/
 *                                      persisting. `comparable: false` with
 *                                      `caveats` when the two were judged by
 *                                      different rulesets or under different
 *                                      finding caps — a statement, never a
 *                                      refusal. Refused for two different sites
 *                                      and for a crawl nobody judged
 *   GET  /compare/urls                 the URLs behind one of those three counts,
 *                                      paginated — the counts are on the summary
 *                                      and the URLs are only here (obligation 1)
 *
 * ## What a caller can never be told
 *
 * A response body carries facts and copy: crawl ids, statuses, counts, the
 * caller's own field names, URL-policy reasons. It never carries a stack, a
 * file path, a database URL or an internal hostname (Talos obligation 6). An
 * error this file does not recognise becomes `{error: "internal error",
 * correlationId}` and the detail goes to the server log under that id — so an
 * operator can find it and a tenant cannot read it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { Db } from "../db/client.js";
import type { ApiServerConfig } from "./config.js";
import { checkBearer } from "./auth.js";
import {
  ApiService,
  ServiceError,
  parseRenderCrawlInput,
  parseStartCrawlInput,
  type ServiceErrorCode,
} from "./service.js";

/**
 * Largest request body this server will read.
 *
 * Every route's body is a small JSON object — the crawl-start body is a dozen
 * scalars — so this is two orders of magnitude of headroom and still a bound.
 * It is enforced while reading and nothing past it is ever held: an
 * authenticated caller must not be able to make the server buffer megabytes
 * (the same discipline as the fetch layer's `MAX_BODY`).
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * How much of an oversized body is drained — read and thrown away — so the
 * caller can be TOLD it was too large.
 *
 * Destroying the socket the moment the cap trips is the tempting version and it
 * is wrong: the client is still writing, so it sees a reset instead of the 413
 * and learns nothing about why. Draining a bounded amount buys a real answer at
 * a bounded cost, because the drained bytes are counted and discarded, never
 * buffered. Past this ceiling the caller is not making a mistake, and the
 * socket goes.
 */
const MAX_DRAIN_BYTES = 16 * MAX_BODY_BYTES;

const STATUS_FOR: Record<ServiceErrorCode, number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export interface CreateApiServerOpts {
  db: Db;
  config: ApiServerConfig;
}

export interface ApiServer {
  /** The shared query/command layer. The MCP transport will mount the same one. */
  service: ApiService;
  server: Server;
  /** Resolves with the address actually bound — port 0 gives an ephemeral one. */
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>;
  /** Stop listening, then stop the crawl queue. Safe to call twice. */
  close(): Promise<void>;
}

type Segment = string | { param: string };

interface RequestCtx {
  params: Record<string, string>;
  query: URLSearchParams;
  /** The parsed JSON body, or `undefined` when the request carried none. */
  body: unknown;
}

interface Reply {
  status: number;
  body: unknown;
}

interface Route {
  method: string;
  pattern: Segment[];
  /**
   * Every query parameter this route accepts — a CLOSED list, checked before
   * the handler runs.
   *
   * `parseStartCrawlInput`'s discipline, applied to the other half of the
   * request. A filter the server does not know is not a harmless extra: a
   * caller who writes `?serverity=critical` gets an unfiltered listing and
   * reads it as "these are the critical findings", which is a wrong answer
   * delivered as a 200. The unknown name is refused instead, and the refusal
   * names the accepted set so the typo is one round trip from fixed.
   */
  query: readonly string[];
  handler: (service: ApiService, ctx: RequestCtx) => Promise<Reply>;
}

/** Every listing takes these; each route names its own filters alongside. */
const PAGINATION_PARAMS = ["limit", "cursor"] as const;

export function createApiServer({ db, config }: CreateApiServerOpts): ApiServer {
  const service = new ApiService(db, config);
  const log = config.log ?? ((line: string) => console.error(line));
  const routes = buildRoutes();

  const server = createServer((req, res) => {
    handle(req, res, service, config, routes, log).catch((error: unknown) => {
      // The handler's own catch covers everything a request can do; reaching
      // here means the response machinery itself failed. Say so loudly rather
      // than leaving the socket open.
      log(`api: handler rejected outside the request scope — ${stackOf(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });

  return {
    service,
    server,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("api: server bound to a non-TCP address"));
            return;
          }
          resolve({ port: address.port, host: address.address });
        });
      });
    },
    async close() {
      // The listener first, so nothing new is accepted, then the queue — whose
      // close aborts the crawl in flight and waits for it to record itself.
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeAllConnections();
      await service.close();
    },
  };
}

function buildRoutes(): Route[] {
  const id: Segment = { param: "id" };
  return [
    {
      method: "POST",
      pattern: ["crawls"],
      query: [],
      handler: async (service, ctx) => ({
        status: 202,
        body: await service.startCrawl(parseStartCrawlInput(ctx.body)),
      }),
    },
    {
      method: "GET",
      pattern: ["crawls"],
      query: ["siteUrl", ...PAGINATION_PARAMS],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.listCrawls({
          ...optionalString(ctx.query, "siteUrl"),
          ...optionalNumber(ctx.query, "limit"),
          ...optionalString(ctx.query, "cursor"),
        }),
      }),
    },
    {
      method: "GET",
      pattern: ["crawls", id],
      query: [],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.getCrawl(param(ctx, "id")),
      }),
    },
    {
      method: "POST",
      pattern: ["crawls", id, "fail"],
      query: [],
      handler: async (service, ctx) => {
        noBody(ctx);
        return { status: 200, body: await service.markCrawlFailed(param(ctx, "id")) };
      },
    },
    {
      method: "POST",
      pattern: ["crawls", id, "render"],
      query: [],
      // The one POST here that takes an OPTIONAL body: no body is the automatic
      // pass this route has always run, `{"urls": [...]}` names the pages
      // instead. `parseRenderCrawlInput` refuses an unknown field rather than
      // ignoring it, for `noBody`'s reason — a caller who mistyped the field
      // would otherwise get a 200 describing a selection they did not ask for.
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.renderCrawl(param(ctx, "id"), parseRenderCrawlInput(ctx.body)),
      }),
    },
    {
      method: "POST",
      pattern: ["crawls", id, "rules"],
      query: [],
      handler: async (service, ctx) => {
        noBody(ctx);
        return { status: 200, body: await service.runRulesForCrawl(param(ctx, "id")) };
      },
    },
    // THE QUERY SURFACE. Every one of these is a GET whose whole body is
    // `{items, nextCursor}` — one pagination shape, so an agent that learns to
    // follow a cursor once can follow every listing here. The filters are read
    // off the query string and handed to the service AS STRINGS: this file does
    // not know what a severity is, and validation belongs where the answer does
    // (an unknown value is a 400 naming the field, never an empty page).
    {
      method: "GET",
      pattern: ["crawls", id, "issues"],
      query: ["severity", "checkId", "ruleId", "category", "pageType", ...PAGINATION_PARAMS],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.listIssues(param(ctx, "id"), {
          ...optionalString(ctx.query, "severity"),
          ...optionalString(ctx.query, "checkId"),
          ...optionalString(ctx.query, "ruleId"),
          ...optionalString(ctx.query, "category"),
          ...optionalString(ctx.query, "pageType"),
          ...optionalNumber(ctx.query, "limit"),
          ...optionalString(ctx.query, "cursor"),
        }),
      }),
    },
    {
      method: "GET",
      pattern: ["crawls", id, "issues", { param: "ruleId" }, "urls"],
      query: PAGINATION_PARAMS,
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.listIssueUrls(param(ctx, "id"), param(ctx, "ruleId"), {
          ...optionalNumber(ctx.query, "limit"),
          ...optionalString(ctx.query, "cursor"),
        }),
      }),
    },
    {
      method: "GET",
      pattern: ["crawls", id, "metrics"],
      query: ["metricId", "scope", "scopeValue", ...PAGINATION_PARAMS],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.listMetrics(param(ctx, "id"), {
          ...optionalString(ctx.query, "metricId"),
          ...optionalString(ctx.query, "scope"),
          ...optionalString(ctx.query, "scopeValue"),
          ...optionalNumber(ctx.query, "limit"),
          ...optionalString(ctx.query, "cursor"),
        }),
      }),
    },
    {
      method: "GET",
      pattern: ["crawls", id, "pages"],
      query: [
        "pageType",
        "statusCode",
        "indexable",
        "rendered",
        "fetchClass",
        "discoveredVia",
        ...PAGINATION_PARAMS,
      ],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.listPages(param(ctx, "id"), {
          ...optionalString(ctx.query, "pageType"),
          ...optionalNumber(ctx.query, "statusCode"),
          ...optionalBoolean(ctx.query, "indexable"),
          ...optionalBoolean(ctx.query, "rendered"),
          ...optionalString(ctx.query, "fetchClass"),
          ...optionalString(ctx.query, "discoveredVia"),
          ...optionalNumber(ctx.query, "limit"),
          ...optionalString(ctx.query, "cursor"),
        }),
      }),
    },
    // THE ONE ROUTE THAT IS NOT UNDER A CRAWL. The catalog is a property of the
    // ruleset, and a crawl is an optional projection onto it — which is why
    // `crawlId` is a query parameter here rather than a path segment: without
    // one there is a complete, useful answer (the checklist skeleton), and a
    // path that required an id would have no way to ask for it.
    {
      method: "GET",
      pattern: ["rules"],
      query: ["crawlId"],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.rulesCatalog({ ...optionalString(ctx.query, "crawlId") }),
      }),
    },
    // THE OTHER TWO ROUTES THAT ARE NOT UNDER A CRAWL, and for a stronger
    // reason than the catalog's: a comparison belongs to TWO crawls and neither
    // owns it. `/crawls/:base/compare/:head` would make one of them the subject
    // and hide the other in a trailing segment; both ids are query parameters
    // here because both are equal halves of the question. They are REQUIRED —
    // `requiredString` refuses a missing one by name, rather than letting
    // `assertCrawl` answer "no such crawl ''", which names the wrong problem.
    {
      method: "GET",
      pattern: ["compare"],
      query: ["baseCrawlId", "headCrawlId"],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.compareCrawls(
          requiredString(ctx.query, "baseCrawlId"),
          requiredString(ctx.query, "headCrawlId"),
        ),
      }),
    },
    {
      method: "GET",
      pattern: ["compare", "urls"],
      query: ["baseCrawlId", "headCrawlId", "ruleId", "set", ...PAGINATION_PARAMS],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.listCompareUrls(
          requiredString(ctx.query, "baseCrawlId"),
          requiredString(ctx.query, "headCrawlId"),
          requiredString(ctx.query, "ruleId"),
          requiredString(ctx.query, "set"),
          {
            ...optionalNumber(ctx.query, "limit"),
            ...optionalString(ctx.query, "cursor"),
          },
        ),
      }),
    },
    {
      method: "GET",
      pattern: ["crawls", id, "robots"],
      query: [],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.getRobots(param(ctx, "id")),
      }),
    },
    {
      method: "GET",
      pattern: ["crawls", id, "export"],
      query: ["dataset"],
      handler: async (service, ctx) => ({
        status: 200,
        body: await service.exportCrawl(param(ctx, "id"), {
          ...optionalString(ctx.query, "dataset"),
        }),
      }),
    },
  ];
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: ApiService,
  config: ApiServerConfig,
  routes: Route[],
  log: (line: string) => void,
): Promise<void> {
  // AUTH FIRST, before routing and before the body is read. An unauthenticated
  // caller must not be able to learn which routes exist (a 404 would say so),
  // nor to make the server read 64KB off the wire.
  const auth = checkBearer(req.headers.authorization, config.token);
  if (!auth.ok) {
    res.setHeader("www-authenticate", 'Bearer realm="ariadne"');
    sendJson(res, 401, { error: auth.error });
    // Discard whatever body came with it. `resume()` reads and drops — it never
    // buffers — so a refused request costs no memory, and the connection stays
    // usable rather than being reset under a client that is still writing.
    // This is the same reasoning as the 413 drain; see `MAX_DRAIN_BYTES`.
    req.resume();
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://ariadne.invalid");
  } catch {
    sendJson(res, 400, { error: "request target is not a URL" });
    req.resume();
    return;
  }

  let segments: string[];
  try {
    segments = url.pathname
      .split("/")
      .filter((s) => s !== "")
      .map((s) => decodeURIComponent(s));
  } catch {
    sendJson(res, 400, { error: "request path is not valid percent-encoding" });
    req.resume();
    return;
  }

  const matches = routes
    .map((route) => ({ route, params: matchPattern(route.pattern, segments) }))
    .filter((m): m is { route: Route; params: Record<string, string> } => m.params !== null);

  if (matches.length === 0) {
    sendJson(res, 404, { error: `no route for ${method} /${segments.map(clip).join("/")}` });
    req.resume();
    return;
  }
  const chosen = matches.find((m) => m.route.method === method);
  if (chosen === undefined) {
    const allowed = [...new Set(matches.map((m) => m.route.method))].sort();
    res.setHeader("allow", allowed.join(", "));
    sendJson(res, 405, {
      error: `${method} is not allowed here (allowed: ${allowed.join(", ")})`,
    });
    req.resume();
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      // The socket is gone only in the abusive case (past the drain ceiling);
      // there is nobody left to tell, and saying so into a dead socket would
      // be an unhandled write error rather than a message.
      if (!res.destroyed) {
        sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
      }
      return;
    }
    if (error instanceof BadJson) {
      sendJson(res, 400, { error: "request body is not valid JSON" });
      return;
    }
    throw error;
  }

  try {
    checkQuery(url.searchParams, chosen.route.query);
    const reply = await chosen.route.handler(service, {
      params: chosen.params,
      query: url.searchParams,
      body,
    });
    sendJson(res, reply.status, reply.body);
  } catch (error) {
    if (error instanceof ServiceError) {
      sendJson(res, STATUS_FOR[error.code], { error: error.message });
      return;
    }
    // Everything else is a defect of ours. The caller gets an id; the log gets
    // the stack. Nothing about the inside of this process crosses the wire.
    const correlationId = randomUUID();
    log(
      `api: 500 ${correlationId} ${method} ${url.pathname} — ${stackOf(error)}`,
    );
    sendJson(res, 500, { error: "internal error", correlationId });
  }
}

function matchPattern(pattern: Segment[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i];
    const actual = segments[i];
    if (expected === undefined || actual === undefined) return null;
    if (typeof expected === "string") {
      if (expected !== actual) return null;
      continue;
    }
    if (actual === "") return null;
    params[expected.param] = actual;
  }
  return params;
}

function param(ctx: RequestCtx, name: string): string {
  const value = ctx.params[name];
  if (value === undefined) {
    // A route matched with a parameter this handler asks for: the table and the
    // handler have diverged, which is a defect, not a request problem.
    throw new Error(`api: route parameter '${name}' is missing from a matched route`);
  }
  return value;
}

/**
 * A query string this route understands, or a 400 naming the parameter.
 *
 * The same argument as `noBody` and as `parseStartCrawlInput`'s unknown-field
 * refusal, made about the third place a request can carry an instruction. An
 * ignored `?serverity=critical` is worse than an ignored body: the caller gets
 * a 200 full of rows and believes they are the critical ones.
 */
function checkQuery(query: URLSearchParams, allowed: readonly string[]): void {
  for (const name of query.keys()) {
    if (!allowed.includes(name)) {
      throw new ServiceError(
        "VALIDATION",
        allowed.length === 0
          ? `unknown query parameter '${clip(name)}': this route takes none`
          : `unknown query parameter '${clip(name)}' (accepted: ${allowed.join(", ")})`,
      );
    }
  }
}

/**
 * Routes that take no body refuse one rather than ignoring it. A caller who
 * sent `{"force": true}` to `/fail` believes something happened; silence would
 * let them keep believing it.
 */
function noBody(ctx: RequestCtx): void {
  if (ctx.body !== undefined) {
    throw new ServiceError("VALIDATION", "this route takes no request body");
  }
}

function optionalNumber(query: URLSearchParams, name: string): Record<string, number> {
  const raw = query.get(name);
  if (raw === null) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ServiceError("VALIDATION", `query parameter '${name}' is not a number`);
  }
  return { [name]: value };
}

function optionalString(query: URLSearchParams, name: string): Record<string, string> {
  const raw = query.get(name);
  return raw === null ? {} : { [name]: raw };
}

/**
 * A query parameter the route cannot answer without — absent OR empty is a 400
 * naming it.
 *
 * Empty counts as absent on purpose. `?baseCrawlId=` is a caller who built the
 * URL from a variable that was not set, and passing `""` down would produce a
 * 404 about a crawl called nothing — a refusal that names the wrong problem and
 * sends them looking for a missing crawl instead of a missing value.
 */
function requiredString(query: URLSearchParams, name: string): string {
  const raw = query.get(name);
  if (raw === null || raw === "") {
    throw new ServiceError("VALIDATION", `this route requires a non-empty '${name}' parameter`);
  }
  return raw;
}

/**
 * A boolean query parameter, spelled `true` or `false` and nothing else.
 *
 * NOT truthiness. `indexable=1`, `indexable=yes` and `indexable=no` would all
 * be *something* under a permissive reading, and the third would silently mean
 * `true` — a filter that returns the opposite of what was asked for. Two
 * spellings, and everything else is a 400 naming the parameter.
 */
function optionalBoolean(query: URLSearchParams, name: string): Record<string, boolean> {
  const raw = query.get(name);
  if (raw === null) return {};
  if (raw !== "true" && raw !== "false") {
    throw new ServiceError(
      "VALIDATION",
      `query parameter '${name}' must be 'true' or 'false', got '${clip(raw)}'`,
    );
  }
  return { [name]: raw === "true" };
}

class BodyTooLarge extends Error {}
class BadJson extends Error {}

/**
 * Read the request body, bounded, and parse it as JSON.
 *
 * `undefined` for an empty body, which the routes distinguish from `null` (a
 * caller who literally sent `null` gets "must be a JSON object", not silence).
 * The cap is enforced as bytes arrive: past it the buffer is released and the
 * rest is drained rather than held, so the refusal costs a count and not the
 * memory it refuses. See `MAX_DRAIN_BYTES` for where even that stops.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      if (!tooLarge) {
        tooLarge = true;
        chunks = []; // release what was buffered before the cap tripped
      }
      if (size > MAX_DRAIN_BYTES) {
        req.destroy();
        throw new BodyTooLarge();
      }
      continue;
    }
    chunks.push(buf);
  }
  if (tooLarge) throw new BodyTooLarge();
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadJson();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    // Crawl status changes under the reader; nothing here is cacheable.
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** The log's view of a thrown value: message and stack, never a response's. */
function stackOf(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

/** Bound a caller's own path segment before it is echoed in a 404. */
function clip(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

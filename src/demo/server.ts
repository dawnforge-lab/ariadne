/**
 * The demo surface: one page, one door, and the real API behind both.
 *
 * Two servers, not one. The FRONT server is what a human opens — it serves
 * `index.html` at `/` and proxies `/api/*` — and the API is the ordinary
 * `createApiServer`, constructed here with a token this process invents and
 * nobody is ever told. The page therefore holds no credential: it calls
 * `/api/crawls` with no `Authorization` header at all and the front server
 * signs the call on its way through. That is the whole reason for the proxy.
 * Handing the browser a token instead would put it in the page source, in the
 * network panel, and in whatever the next tab pastes it into.
 *
 * The API listens on an EPHEMERAL LOOPBACK port, and both halves of that are
 * deliberate. Loopback because the token is the only thing in front of a
 * surface that can start crawls, and it is a UUID this process holds — a
 * network-reachable port protected by a secret nobody can be given is a
 * surface with no operator behind it. Ephemeral because nothing but this file
 * ever addresses it: no config names it, no client discovers it, and two demos
 * on one machine must not fight over a number. `listen` returns it only so a
 * test can prove the port still 401s (`test/demo/serve.test.ts`).
 *
 * `allowAnyPublicHost` is set here and this is its only production setter. The
 * demo's point is "type any URL", which the crawl-trigger allowlist exists to
 * forbid, so the posture opens that gate and nothing else: `isUrlAllowed` still
 * answers on every URL and `allowPrivate` is NEVER set from this file, so
 * loopback and RFC1918 targets stay refused (see `ServiceConfig`). The
 * `crawlDefaults` opt exists for the test suite, which needs its own fixture
 * server crawlable; the `npm run demo` entrypoint does not pass it.
 */
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Db } from "../db/client.js";
import { createApiServer, type ApiServer } from "../api/http.js";
import type { ServiceConfig } from "../api/config.js";

/**
 * The page, read once at import.
 *
 * A missing or unreadable file throws here — at startup, in the operator's
 * face — rather than becoming a 404 or an empty body per request (hard rule 7).
 */
const PAGE = readFileSync(new URL("./index.html", import.meta.url));

/**
 * Response headers that cross back from the API to the browser.
 *
 * A CLOSED list, because a proxy that forwards everything forwards things it
 * has not thought about, and these three are all the API ever sets: the media
 * type, the export's download filename, and the `no-store` that keeps a crawl's
 * moving state out of a cache. Nothing is invented when a header is absent —
 * labelling an unknown body `application/json` would be this file guessing on
 * the service's behalf.
 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-disposition", "cache-control"] as const;

export interface CreateDemoServerOpts {
  db: Db;
  /** Test seam only — the demo entrypoint never passes it. Same contract as ApiServerConfig.crawlDefaults. */
  crawlDefaults?: ServiceConfig["crawlDefaults"];
  renderDir?: string;
  exportDir?: string;
  log?: (line: string) => void;
}

export interface DemoServer {
  /** Starts the API on an ephemeral loopback port FIRST, then the front server. */
  listen(port?: number, host?: string): Promise<{ port: number; host: string; apiPort: number }>;
  /** Front server first, then the API (which stops the crawl queue). Safe to call twice. */
  close(): Promise<void>;
}

export function createDemoServer(opts: CreateDemoServerOpts): DemoServer {
  // Never printed, never served, never in the page: the browser talks only
  // to this front server, which signs every /api call itself.
  const token = randomUUID();
  const api: ApiServer = createApiServer({
    db: opts.db,
    config: {
      token,
      // Empty AND open: the posture is what accepts a typed-in host, so the
      // list has nothing to say. `allowPrivate` is absent by construction.
      allowedDomains: [],
      allowAnyPublicHost: true,
      ...(opts.crawlDefaults === undefined ? {} : { crawlDefaults: opts.crawlDefaults }),
      ...(opts.renderDir === undefined ? {} : { renderDir: opts.renderDir }),
      ...(opts.exportDir === undefined ? {} : { exportDir: opts.exportDir }),
      ...(opts.log === undefined ? {} : { log: opts.log }),
    },
  });

  let apiPort = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    // `/api` is a PREFIX, stripped rather than rewritten: `/api/crawls/x/issues?limit=5`
    // reaches the service as `/crawls/x/issues?limit=5`, query string and all.
    // The bare `/api` and `/api?...` spellings are kept because a proxy that
    // 404s a path the service would have answered is a wrong answer told twice.
    const rest = url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")
      ? url.slice(4)
      : null;
    if (rest !== null) {
      const path = rest === "" || rest.startsWith("?") ? `/${rest}` : rest;
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      const contentType = req.headers["content-type"];
      if (contentType !== undefined) headers["content-type"] = contentType;
      const upstream = httpRequest(
        { host: "127.0.0.1", port: apiPort, path, method: req.method, headers },
        (answer) => {
          const out: Record<string, string | string[]> = {};
          for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = answer.headers[name];
            if (value !== undefined) out[name] = value;
          }
          // A response with no status line cannot happen on a real socket; if
          // it somehow does, 502 says so rather than passing a 200 upward.
          res.writeHead(answer.statusCode ?? 502, out);
          answer.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        // rule 7: the proxy failing is a loud 502 with the reason, not a hang.
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `demo proxy: ${String(error)}` }));
        } else {
          res.destroy();
        }
      });
      req.pipe(upstream);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found: the demo serves / and /api/* only" }));
  });

  let closed = false;
  return {
    async listen(port = 8484, host = "127.0.0.1") {
      const boundApi = await api.listen(0, "127.0.0.1");
      apiPort = boundApi.port;
      // `error` is a listener rather than a thrown event for the case an
      // operator will actually hit: port 8484 already taken. It has to be an
      // EADDRINUSE the caller can print, not a promise that never settles.
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("demo: front server bound to a non-TCP address"));
            return;
          }
          resolve({ port: address.port, host: address.address, apiPort });
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      // The front door first, so no new request can reach an API that is
      // shutting down; then the API, whose close stops the crawl queue.
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeAllConnections();
      await api.close();
    },
  };
}

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
 *
 * ## The door has a lock: `crossOriginRefusal`
 *
 * The premise above — the token is never in the page — has a consequence that
 * has to be paid for. Because the proxy signs by ORIGIN OF REQUEST rather than
 * by anything the caller presents, it is ambient authority for every tab in
 * the operator's browser: any web page in the world can `fetch` this port with
 * a CORS-simple request, and without a check it would be signed and would start
 * a crawl of the attacker's choosing, through an open allowlist, from the
 * operator's own address. The response is unreadable to that page, which is
 * exactly why the danger is the crawl and not the answer.
 *
 * So the proxy refuses a request whose `sec-fetch-site` says it came from
 * somewhere else, or whose `Origin` is not this server's own — loudly, with the
 * offending value named. Requests carrying NEITHER header are accepted, because
 * that is `curl`, the test suite, and a browser's own same-origin GET; the two
 * headers are what a browser adds when the request comes from a page, and a
 * page cannot forge either one.
 */
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
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
 * has not thought about. It names every header `src/api/http.ts` sets: the
 * media type, the export's download filename, the `no-store` that keeps a
 * crawl's moving state out of a cache, and the two a refusal carries — `allow`
 * on a 405 and `www-authenticate` on a 401 (which the browser should never see,
 * since this proxy is what signs the call; if one arrives, the caller is told
 * what the API actually said). Nothing is invented when a header is absent —
 * labelling an unknown body `application/json` would be this file guessing on
 * the service's behalf.
 */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "cache-control",
  "allow",
  "www-authenticate",
] as const;

/**
 * How much of a rejected header value is quoted back in the refusal.
 *
 * The value is the caller's own, so it is echoed to name the problem — and
 * bounded, because a refusal must not become an amplifier for whatever the
 * caller chose to send.
 */
const REFUSAL_ECHO_CHARS = 120;

/**
 * Why this proxied request must not be signed, or `null` when it may be.
 *
 * Two questions, both answered from headers a page cannot set for itself:
 *
 *  - `Sec-Fetch-Site` is the browser's own statement about where the request
 *    came from. Anything but `same-origin` (this page) or `none` (the user
 *    typed it) is another site using our credentials.
 *  - `Origin` is compared against the origin the caller ITSELF addressed —
 *    `http://` plus the request's `Host` — rather than against the bound
 *    socket. That is the comparison that stays true when the operator opens
 *    `http://localhost:8484` while the server bound `127.0.0.1`: both sides of
 *    the check then read `localhost:8484`, and a page on any other origin still
 *    cannot make the two agree. The scheme is part of the string, so an
 *    `https://` origin naming the same host is a mismatch, which is correct.
 *
 * Absent headers are ACCEPTED and that is not a hole: `curl`, the test suite
 * and a same-origin browser GET all arrive without them, and the request that
 * this check exists to stop — a cross-origin `fetch` — is made by a browser,
 * which always attaches at least one.
 */
function crossOriginRefusal(req: IncomingMessage): string | null {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") {
    return `sec-fetch-site: ${site.slice(0, REFUSAL_ECHO_CHARS)}`;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "" && origin !== `http://${req.headers.host ?? ""}`) {
    return `origin: ${origin.slice(0, REFUSAL_ECHO_CHARS)}`;
  }
  return null;
}

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
      // THE DOOR'S LOCK, before anything is signed. See `crossOriginRefusal`:
      // this proxy's authority is ambient, so the one thing it must never do is
      // sign a request another site made on the operator's behalf.
      const refusal = crossOriginRefusal(req);
      if (refusal !== null) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "cross-origin request refused: the demo proxy signs calls from its own page only " +
              `(${refusal})`,
          }),
        );
        return;
      }
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
      // THE CLIENT CAN VANISH MID-RESPONSE — a tab closed during a CSV export
      // is the case that matters, because that response is a streamed database
      // read. `answer.pipe(res)` is the only link between the two halves and it
      // does not carry a cancellation backwards: on an early close it unpipes
      // and leaves the upstream response paused FOREVER, so the API handler sits
      // in `sendCsv`'s `once(res, "drain")` holding its reader, the connection
      // never goes idle, and `close()` — which waits for exactly that — hangs on
      // shutdown. Destroying the upstream request propagates the disconnect to
      // the surface doing the work, which is where it means something.
      let clientGone = false;
      res.on("close", () => {
        if (res.writableEnded) return;
        clientGone = true;
        upstream.destroy();
      });
      upstream.on("error", (error) => {
        // The disconnect we caused ourselves, arriving as the socket's own
        // error: there is nobody left to answer, and saying so would be noise.
        if (clientGone || res.destroyed) return;
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
      try {
        await new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error === undefined ? resolve() : reject(error)));
          // Inside the promise, not after it: `close`'s callback fires when the
          // last connection ends, so a browser holding a keep-alive socket open
          // would otherwise keep this await pending and the call that was meant
          // to release the connections would never be reached.
          server.closeAllConnections();
        });
      } finally {
        // The API closes even if the front server's close rejected. A demo that
        // failed halfway and left the crawl queue running is the worse failure,
        // and the rejection still propagates.
        await api.close();
      }
    },
  };
}

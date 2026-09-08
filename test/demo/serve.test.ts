/**
 * The demo server: one door in front of the real API, and what it does NOT do.
 *
 * `createDemoServer` is two servers — a page host on a loopback port a human
 * opens, and the ordinary `createApiServer` on an ephemeral loopback port with
 * a per-process token nobody is ever told. The front server signs every `/api`
 * call itself, so the interesting properties are not "the page loads" but the
 * two halves of the seam: the proxy DOES inject the bearer (a 401 here means it
 * did not), and the internal port is still shut without it.
 *
 * The refusal test is the third: a 400 from the service arrives at the browser
 * AS a 400 with the service's own reason. A proxy that smoothed that into a 200
 * with an empty body — or into a 502 of its own words — would be the silent
 * fallback hard rule 7 forbids, one layer further out than usual.
 *
 * The fourth is the lock on that door. Because the proxy signs by origin of
 * request rather than by anything the caller holds, every tab in the operator's
 * browser can reach it — so the cross-origin cases below are not paperwork,
 * they are the difference between a demo and a crawl-anything service pointed
 * at the operator's own address. The rebinding case is the sharpest of them:
 * `Origin` and `Sec-Fetch-Site` can BOTH be the attacker's and both agree, so
 * the test that matters is the one that pins `Host`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createDemoServer, type DemoServer } from "../../src/demo/server.js";

let db: Db;
let demo: DemoServer;
let base: string;
let port = 0;
let apiPort = 0;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  db = createDb(url);
  await runMigrations(db);
  demo = createDemoServer({ db });
  const bound = await demo.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${bound.port}`;
  port = bound.port;
  apiPort = bound.apiPort;
  // The migrations run here, and on a cold database they are not instant: the
  // hook carries the same 60s the file's siblings do, so a slow CI start is a
  // slow test rather than a timeout that names nothing.
}, 60_000);

afterAll(async () => {
  await demo.close();
  await closeDb(db);
});

describe("the page", () => {
  it("serves the demo page at / as html", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain('id="site-url"');
  });

  it("answers 404 for a path that is neither the page nor /api", async () => {
    const res = await fetch(`${base}/anything-else`);
    expect(res.status).toBe(404);
  });
});

describe("the proxy", () => {
  it("injects the bearer so /api reaches the real surface", async () => {
    const res = await fetch(`${base}/api/crawls`);
    expect(res.status).toBe(200); // crawl_list; 401 here means no injection
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body["items"])).toBe(true);
  });

  it("is the only door: the internal API port still refuses without the token", async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/crawls`);
    expect(res.status).toBe(401);
  });

  it("passes a refusal through untouched — transparent errors, no fallback", async () => {
    const res = await fetch(`${base}/api/crawls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteUrl: "not-a-url" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body["error"])).toContain("siteUrl");
  });

  it("preserves the query string", async () => {
    const res = await fetch(`${base}/api/rules?crawlId=crawl_nope`);
    // 404/409 from the service, NOT a proxy-level 404 — the query survived
    expect([404, 409]).toContain(res.status);
  });
});

describe("the door's lock", () => {
  /**
   * The attacker's request: a CORS-simple POST from any page in the world.
   *
   * The body is deliberately INVALID. What is being tested is which gate
   * answers, and a `siteUrl` the service would accept would mean a broken lock
   * crawls a real site from this suite. A lock that lets this through says 400;
   * the lock says 403.
   */
  async function fromAnotherPage(headers: Record<string, string>): Promise<Response> {
    return fetch(`${base}/api/crawls`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ siteUrl: "not-a-url" }),
    });
  }

  it("refuses a request whose Origin is not this server's own", async () => {
    const res = await fromAnotherPage({ origin: "http://evil.example" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    // Named, not implied: the refusal quotes the value it refused (rule 7).
    expect(String(body["error"])).toContain("cross-origin");
    expect(String(body["error"])).toContain("http://evil.example");
  });

  it("refuses a request the browser itself calls cross-site", async () => {
    const res = await fromAnotherPage({ "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(String(((await res.json()) as Record<string, unknown>)["error"])).toContain(
      "cross-site",
    );
  });

  it("accepts the page's own request: sec-fetch-site: same-origin with a matching Origin", async () => {
    // What the demo page's own fetch looks like on the wire — and the reason
    // the check compares Origin against the request's own Host rather than the
    // bound socket: `localhost` and `127.0.0.1` are different origins to a
    // browser, and only the Host the caller addressed can agree with both.
    // The service's own 400 is the proof it got past the lock.
    const res = await fromAnotherPage({ "sec-fetch-site": "same-origin", origin: base });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as Record<string, unknown>)["error"])).toContain("siteUrl");
  });

  it("accepts a request carrying neither header — curl, and this test suite", async () => {
    const res = await fetch(`${base}/api/crawls`);
    expect(res.status).toBe(200);
  });

  /**
   * `Host` set by hand, which `fetch` will not do — and which is exactly the
   * thing a rebound DNS name does for free.
   */
  function withHost(host: string, extra: Record<string, string> = {}): Promise<{
    status: number;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/crawls",
          method: "GET",
          headers: { host, ...extra },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("refuses a rebound host: every other header agrees, and all of them are the attacker's", async () => {
    // DNS rebinding, as it arrives on the wire. `evil.example` resolved to
    // 127.0.0.1, so the browser calls this page same-origin and would READ the
    // answers — the kept crawls — as well as start new ones. Origin agrees with
    // Host, which is why an Origin-versus-Host check alone proves nothing.
    const res = await withHost(`evil.example:${port}`, {
      origin: `http://evil.example:${port}`,
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("host: evil.example");
  });

  it("still accepts the localhost spelling of its own address", async () => {
    // The control the host check must not break: `localhost` and `127.0.0.1`
    // are different origins to a browser, and the operator types either.
    const res = await withHost(`localhost:${port}`, {
      origin: `http://localhost:${port}`,
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(200);
  });
});

/**
 * A closed tab, mid-response.
 *
 * The abort here DOES reach the handler this covers — measured with a probe:
 * the front `res` closes with `writableEnded === false` and the upstream
 * request is destroyed.
 *
 * WHAT IT DOES NOT PROVE, stated so nobody reads more into a green than it
 * carries: the failure that handling exists for is a response still being
 * WRITTEN when the client goes — a CSV export, whose `sendCsv` sits in
 * `once(res, "drain")` between records, wedged forever once `pipe` unpipes.
 * Reproducing THAT needs a body larger than the loopback socket buffers, and
 * the largest this surface has without crawl data is the ~108KB rule catalog,
 * which the kernel swallows whole. So both assertions below hold with or
 * without the handler; what they establish is that the abort path runs, does no
 * harm, and leaves the demo serving and its `close` prompt.
 */
describe("a client that leaves", () => {
  /**
   * Ask for the largest body this surface has (the rule catalog, ~108KB) and
   * hang up the moment the request is on the wire — before the answer is,
   * which is what puts the front server's `res` into `close` with nothing
   * written and reaches the handler under test.
   */
  function abortMidResponse(port: number, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
          () => {
            socket.destroy();
            resolve();
          },
        );
      });
      socket.once("error", reject);
    });
  }

  it("leaves nothing wedged: the demo still answers, and still closes", async () => {
    // Its own server, because the assertion is about close() and the shared one
    // has to survive the rest of the file.
    const own = createDemoServer({ db });
    const bound = await own.listen(0, "127.0.0.1");
    await abortMidResponse(bound.port, "/api/rules");

    const after = await fetch(`http://127.0.0.1:${bound.port}/api/crawls`);
    expect(after.status).toBe(200);
    await after.text();

    // `close` waits for connections to go idle, and an upstream request nobody
    // cancelled never does — see this block's docblock for why a 108KB body
    // cannot be made to stay in flight long enough to show that here.
    const closed = own.close().then(() => "closed" as const);
    const timer = new Promise<"hung">((resolve) => {
      setTimeout(() => resolve("hung"), 10_000).unref();
    });
    expect(await Promise.race([closed, timer])).toBe("closed");
  });

  it("close() is safe to call twice", async () => {
    const own = createDemoServer({ db });
    await own.listen(0, "127.0.0.1");
    await own.close();
    await own.close();
  });
});

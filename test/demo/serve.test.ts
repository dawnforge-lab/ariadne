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
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createDemoServer, type DemoServer } from "../../src/demo/server.js";

let db: Db;
let demo: DemoServer;
let base: string;
let apiPort = 0;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
  db = createDb(url);
  await runMigrations(db);
  demo = createDemoServer({ db });
  const bound = await demo.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${bound.port}`;
  apiPort = bound.apiPort;
});

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

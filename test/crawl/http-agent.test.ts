/**
 * Build-plan §7 "before the first real-site crawl", item 2: the per-origin
 * connection cap on the undici agent.
 *
 * Politeness (rule 9) was paced by the host gate alone — one *navigation* per
 * `perHostDelayMs` per host — and nothing bounded how many *sockets* a crawl
 * could hold open against a single origin. On a fixture server that answers in
 * a millisecond the two are indistinguishable; against a real origin that
 * takes seconds, `maxConcurrency` requests would sit on `maxConcurrency` open
 * connections. This file observes the sockets, from the server's side, because
 * that is the only place the number is a fact rather than a config value.
 *
 * Its own server and its own file: the shared agent keeps connections alive
 * between fetches, so a peak-concurrency count is only meaningful when nothing
 * else in the process has been talking to the same origin.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchPage } from "../../src/crawl/fetch-page.js";
import {
  closeFetchAgents,
  MAX_CONNECTIONS_PER_ORIGIN,
} from "../../src/crawl/http.js";

let server: Server;
let base: string;
const OPTS = { userAgent: "AriadneBot-test", allowPrivate: true };

/** Sockets open to this server right now, and the high-water mark. */
let openSockets = 0;
let peakSockets = 0;

/** Requests in flight server-side, so we can prove the responses really overlap. */
let inFlight = 0;
let peakInFlight = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    // Long enough that a second request cannot be served on the same socket
    // before the first has been dispatched — the pool has to either open
    // another connection or queue.
    setTimeout(() => {
      inFlight--;
      res.setHeader("content-type", "text/html");
      res.end(`<html><title>${String(req.url)}</title></html>`);
    }, 120);
  });
  server.on("connection", (socket) => {
    openSockets++;
    peakSockets = Math.max(peakSockets, openSockets);
    socket.on("close", () => {
      openSockets--;
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await closeFetchAgents();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("per-origin connection cap", () => {
  it("holds no more sockets to one origin than the cap, however many fetches are in flight", async () => {
    // Twice the cap, all against the same origin, all at once — the shape a
    // crawl with maxConcurrency 16 takes on a single-host site the moment the
    // host gate lets a burst through.
    const requested = MAX_CONNECTIONS_PER_ORIGIN * 2;
    const results = await Promise.all(
      Array.from({ length: requested }, (_, i) => fetchPage(`${base}/p${i}`, OPTS)),
    );

    // Every request still completes: the cap queues, it does not drop.
    for (const [i, r] of results.entries()) {
      expect(r.fetchClass).toBe("ok");
      expect(r.body).toContain(`<title>/p${i}</title>`);
    }

    expect(peakSockets).toBeLessThanOrEqual(MAX_CONNECTIONS_PER_ORIGIN);
    // …and the cap is the thing doing the limiting, not a slow test: without
    // it undici would have opened one socket per in-flight request.
    expect(peakSockets).toBeGreaterThan(1);
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(MAX_CONNECTIONS_PER_ORIGIN);
  });
});

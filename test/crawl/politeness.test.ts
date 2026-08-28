import { describe, expect, it } from "vitest";
import {
  CrawlWindow,
  HostGate,
  type BatchOutcome,
} from "../../src/crawl/politeness.js";

const ok = (ms = 100): BatchOutcome => ({
  fetchClass: "ok",
  responseTimeMs: ms,
  htmlBytes: 1000,
});

describe("CrawlWindow", () => {
  it("halves on a blocked outcome", () => {
    const w = new CrawlWindow({ initial: 8, max: 16 });
    w.onBatchSettled([ok(), { ...ok(), fetchClass: "blocked" }]);
    expect(w.size()).toBe(4);
  });

  it("never shrinks below 1", () => {
    const w = new CrawlWindow({ initial: 1, max: 16 });
    w.onBatchSettled([{ ...ok(), fetchClass: "timeout" }]);
    expect(w.size()).toBe(1);
  });

  it("grows only on a clean, full, fast batch", () => {
    const w = new CrawlWindow({ initial: 4, max: 16 });
    w.onBatchSettled([ok(), ok(), ok()]); // partial batch → no growth
    expect(w.size()).toBe(4);
    w.onBatchSettled([ok(), ok(), ok(), ok()]); // full & fast → +1
    expect(w.size()).toBe(5);
    w.onBatchSettled([ok(3000), ok(), ok(), ok(), ok()]); // slow p95 → no growth
    expect(w.size()).toBe(5);
  });

  it("byte budget admits and releases", () => {
    const w = new CrawlWindow({ initial: 4, max: 16, byteBudget: 1000 });
    expect(w.admitBytes(800)).toBe(true);
    expect(w.admitBytes(300)).toBe(false);
    w.releaseBytes(800);
    expect(w.admitBytes(300)).toBe(true);
  });

  // --- beyond the brief: the policy edges the loop will actually hit ---

  it("starts at 4 when no initial is given", () => {
    expect(new CrawlWindow({ max: 16 }).size()).toBe(4);
  });

  it("shrinks on server_error too, and floors the halving", () => {
    const w = new CrawlWindow({ initial: 5, max: 16 });
    w.onBatchSettled([ok(), ok(), ok(), ok(), { ...ok(), fetchClass: "server_error" }]);
    expect(w.size()).toBe(2); // floor(5/2)
  });

  it("shrinks even on a full, fast batch when one outcome is an error", () => {
    const w = new CrawlWindow({ initial: 4, max: 16 });
    w.onBatchSettled([ok(), ok(), ok(), { ...ok(), fetchClass: "blocked" }]);
    expect(w.size()).toBe(2);
  });

  it("treats non-blocking failure classes as clean", () => {
    // client_error / non_html / too_large are the site's business, not a
    // throttling signal: the window must not collapse on a wall of 404s.
    // `unsupported_encoding` joins them for the same reason — a CDN that
    // answers `br` whatever we asked for answers it just as fast however
    // slowly we crawl, so backing off buys nothing.
    const w = new CrawlWindow({ initial: 4, max: 16 });
    w.onBatchSettled([
      { ...ok(), fetchClass: "client_error" },
      { ...ok(), fetchClass: "non_html" },
      { ...ok(), fetchClass: "too_large" },
      { ...ok(), fetchClass: "redirect" },
      { ...ok(), fetchClass: "unsupported_encoding" },
    ]);
    expect(w.size()).toBe(5);
  });

  it("never grows past max", () => {
    const w = new CrawlWindow({ initial: 2, max: 3 });
    w.onBatchSettled([ok(), ok()]);
    expect(w.size()).toBe(3);
    w.onBatchSettled([ok(), ok(), ok()]);
    expect(w.size()).toBe(3);
  });

  it("ignores an empty batch", () => {
    const w = new CrawlWindow({ initial: 4, max: 16 });
    w.onBatchSettled([]);
    expect(w.size()).toBe(4);
  });

  it("admits when nothing is in flight, whatever the size", () => {
    // Progress guarantee: a lone oversized body must not deadlock the loop.
    const w = new CrawlWindow({ max: 4, byteBudget: 1000 });
    expect(w.admitBytes(5000)).toBe(true);
    expect(w.admitBytes(1)).toBe(false);
  });

  it("defaults the byte budget to 64MiB", () => {
    const w = new CrawlWindow({ max: 4 });
    expect(w.admitBytes(64 * 1024 * 1024)).toBe(true);
    expect(w.admitBytes(1)).toBe(false);
  });

  it("rejects nonsense construction and misuse loudly", () => {
    expect(() => new CrawlWindow({ max: 0 })).toThrow(RangeError);
    expect(() => new CrawlWindow({ initial: 9, max: 8 })).toThrow(RangeError);
    expect(() => new CrawlWindow({ max: 4, byteBudget: 0 })).toThrow(RangeError);
    expect(() => new CrawlWindow({ max: 4, slowMs: 0 })).toThrow(RangeError);
    const w = new CrawlWindow({ max: 4 });
    expect(() => w.admitBytes(-1)).toThrow(RangeError);
    expect(() => w.releaseBytes(10)).toThrow(RangeError); // released more than admitted
  });
});

describe("HostGate", () => {
  it("takes the max of config and robots delay, capped", () => {
    expect(
      new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: 5 }).effectiveDelayMs(),
    ).toBe(5000);
    expect(
      new HostGate({ perHostDelayMs: 8000, robotsCrawlDelaySec: 2 }).effectiveDelayMs(),
    ).toBe(8000);
    expect(
      new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: 900 }).effectiveDelayMs(),
    ).toBe(30000);
  });

  it("spaces two acquisitions of the same host by the delay", async () => {
    const g = new HostGate({ perHostDelayMs: 120, robotsCrawlDelaySec: null });
    const t0 = Date.now();
    await g.acquire("a.example");
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it("different hosts do not wait on each other", async () => {
    const g = new HostGate({ perHostDelayMs: 500, robotsCrawlDelaySec: null });
    const t0 = Date.now();
    await g.acquire("a.example");
    await g.acquire("b.example");
    expect(Date.now() - t0).toBeLessThan(100);
  });

  // --- beyond the brief ---

  it("chains concurrent acquirers of one host instead of releasing them together", async () => {
    const g = new HostGate({ perHostDelayMs: 60, robotsCrawlDelaySec: null });
    const t0 = Date.now();
    const at: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        await g.acquire("a.example");
        at.push(Date.now() - t0);
      }),
    );
    at.sort((a, b) => a - b);
    expect(at[0]).toBeLessThan(50);
    expect(at[1]).toBeGreaterThanOrEqual(50);
    expect(at[2]).toBeGreaterThanOrEqual(110);
  });

  it("gives elapsed-time credit: a cold host is admitted immediately", async () => {
    const g = new HostGate({ perHostDelayMs: 40, robotsCrawlDelaySec: null });
    await g.acquire("a.example");
    await new Promise((r) => setTimeout(r, 60));
    const t0 = Date.now();
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeLessThan(20);
  });

  it("honours an explicit maxDelayMs and a zero delay", async () => {
    expect(
      new HostGate({
        perHostDelayMs: 1000,
        robotsCrawlDelaySec: 60,
        maxDelayMs: 2000,
      }).effectiveDelayMs(),
    ).toBe(2000);
    const g = new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null });
    expect(g.effectiveDelayMs()).toBe(0);
    const t0 = Date.now();
    await g.acquire("a.example");
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeLessThan(20);
  });

  it("rejects nonsense construction loudly", () => {
    expect(() => new HostGate({ perHostDelayMs: -1, robotsCrawlDelaySec: null })).toThrow(
      RangeError,
    );
    expect(() => new HostGate({ perHostDelayMs: 100, robotsCrawlDelaySec: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      new HostGate({ perHostDelayMs: 100, robotsCrawlDelaySec: null, maxDelayMs: 0 }),
    ).toThrow(RangeError);
  });
});

/**
 * The adaptive half of the gate (Task 6b). The fixed base is what we ASKED to
 * crawl at; this is what the site's answers make us crawl at.
 */
describe("HostGate escalation", () => {
  const blocked = { fetchClass: "blocked", retryAfterMs: null } as const;
  const fine = { fetchClass: "ok", retryAfterMs: null } as const;

  it("doubles a host's spacing per block, and leaves the base alone", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    expect(g.spacingMs("a.example")).toBe(1000);

    g.report("a.example", blocked);
    expect(g.spacingMs("a.example")).toBe(2000);
    g.report("a.example", blocked);
    expect(g.spacingMs("a.example")).toBe(4000);
    g.report("a.example", blocked);
    expect(g.spacingMs("a.example")).toBe(8000);

    // The configured/robots base is a fact about the crawl's configuration and
    // never moves — only the live spacing does.
    expect(g.effectiveDelayMs()).toBe(1000);
    // And it is per host: nobody else pays for one host's WAF.
    expect(g.spacingMs("b.example")).toBe(1000);
  });

  it("ratchets: a success never buys the spacing back", () => {
    const g = new HostGate({ perHostDelayMs: 500, robotsCrawlDelaySec: null });
    g.report("a.example", blocked);
    g.report("a.example", blocked);
    expect(g.spacingMs("a.example")).toBe(2000);

    g.report("a.example", fine);
    g.report("a.example", fine);
    expect(g.spacingMs("a.example")).toBe(2000);

    // And the next block escalates from where the ratchet stands, not from the
    // base: a bucket that tripped three times is not a bucket to probe gently.
    g.report("a.example", blocked);
    expect(g.spacingMs("a.example")).toBe(4000);
  });

  it("caps the escalation at maxDelayMs", () => {
    const g = new HostGate({
      perHostDelayMs: 1000,
      robotsCrawlDelaySec: null,
      maxDelayMs: 5000,
    });
    for (let i = 0; i < 20; i += 1) g.report("a.example", blocked);
    expect(g.spacingMs("a.example")).toBe(5000);
  });

  it("escalates a zero-delay crawl from a seed rather than doubling nothing", () => {
    // perHostDelayMs 0 is the configuration in which a 429 matters most, and
    // 0 * 2 is 0 — the ratchet would be a silent no-op.
    const g = new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null });
    expect(g.spacingMs("a.example")).toBe(0);
    g.report("a.example", blocked);
    expect(g.spacingMs("a.example")).toBe(1000);
    g.report("a.example", blocked);
    expect(g.spacingMs("a.example")).toBe(2000);
  });

  it("reports the widest spacing in force, for lease sizing", () => {
    const g = new HostGate({ perHostDelayMs: 100, robotsCrawlDelaySec: null });
    expect(g.maxSpacingMs()).toBe(100);
    g.report("a.example", blocked);
    g.report("a.example", blocked);
    g.report("b.example", blocked);
    expect(g.maxSpacingMs()).toBe(400);
  });

  it("spaces the next acquisition by the escalated delay, not the base", async () => {
    const g = new HostGate({ perHostDelayMs: 20, robotsCrawlDelaySec: null });
    await g.acquire("a.example"); // cold host: admitted at once
    g.report("a.example", blocked); // -> 40ms
    g.report("a.example", blocked); // -> 80ms
    const t0 = Date.now();
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it("honours Retry-After as a floor under the escalated spacing", async () => {
    const g = new HostGate({ perHostDelayMs: 5, robotsCrawlDelaySec: null });
    await g.acquire("a.example");
    g.report("a.example", { fetchClass: "blocked", retryAfterMs: 120 });
    const t0 = Date.now();
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it("takes the escalated spacing when it is the longer of the two", async () => {
    const g = new HostGate({ perHostDelayMs: 60, robotsCrawlDelaySec: null });
    await g.acquire("a.example");
    // 60 -> 120 escalated, against a 1ms Retry-After: the floor loses.
    g.report("a.example", { fetchClass: "blocked", retryAfterMs: 1 });
    const t0 = Date.now();
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it("caps a hostile Retry-After at maxDelayMs instead of parking the crawl", async () => {
    // "Retry-After: 31536000" — a year. Honoured literally it ends the crawl.
    const g = new HostGate({
      perHostDelayMs: 1,
      robotsCrawlDelaySec: null,
      maxDelayMs: 60,
    });
    await g.acquire("a.example");
    g.report("a.example", {
      fetchClass: "server_error",
      retryAfterMs: 365 * 24 * 3600 * 1000,
    });
    const t0 = Date.now();
    await g.acquire("a.example");
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(40);
    expect(waited).toBeLessThan(2000);
  });

  it("honours a Retry-After on a class that is not blocked (a 503 asking us to wait)", () => {
    const g = new HostGate({ perHostDelayMs: 10, robotsCrawlDelaySec: null });
    g.report("a.example", { fetchClass: "server_error", retryAfterMs: 500 });
    // The floor is a slot, not an escalation: the spacing itself is untouched.
    expect(g.spacingMs("a.example")).toBe(10);
  });

  it("refuses a nonsense Retry-After from our own parser loudly", () => {
    const g = new HostGate({ perHostDelayMs: 10, robotsCrawlDelaySec: null });
    expect(() =>
      g.report("a.example", { fetchClass: "blocked", retryAfterMs: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      g.report("a.example", { fetchClass: "blocked", retryAfterMs: Number.NaN }),
    ).toThrow(RangeError);
  });
});

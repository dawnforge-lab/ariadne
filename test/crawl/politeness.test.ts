import { describe, expect, it } from "vitest";
import {
  CrawlWindow,
  HostGate,
  RECOVERY_STREAK,
  type BatchOutcome,
  type HostOutcome,
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

  // --- the earned spacing a resumed crawl carries back in (P12-T3) ---

  it("folds the spacing an earlier run earned into the crawl's base", () => {
    // `crawls.host_spacing_ms` is a FINDING — the site pushed back and the
    // engine listened — so a second run over the same crawl starts where the
    // first one ended rather than at the configured floor.
    expect(
      new HostGate({
        perHostDelayMs: 1000,
        robotsCrawlDelaySec: null,
        earnedSpacingMs: 8000,
      }).effectiveDelayMs(),
    ).toBe(8000);
    // Max, not replace: a caller who asks for more room than the crawl earned
    // keeps it, and a crawl that never escalated changes nothing.
    expect(
      new HostGate({
        perHostDelayMs: 8000,
        robotsCrawlDelaySec: null,
        earnedSpacingMs: 1000,
      }).effectiveDelayMs(),
    ).toBe(8000);
    expect(
      new HostGate({
        perHostDelayMs: 1000,
        robotsCrawlDelaySec: null,
        earnedSpacingMs: null,
      }).effectiveDelayMs(),
    ).toBe(1000);
    // The cap binds it exactly as it binds robots and the ratchet: past 30s the
    // crawl stops being a crawl.
    expect(
      new HostGate({
        perHostDelayMs: 1000,
        robotsCrawlDelaySec: null,
        earnedSpacingMs: 90_000,
      }).effectiveDelayMs(),
    ).toBe(30_000);
    // And it is the widest of the three, not the last of them.
    expect(
      new HostGate({
        perHostDelayMs: 500,
        robotsCrawlDelaySec: 3,
        earnedSpacingMs: 1000,
      }).effectiveDelayMs(),
    ).toBe(3000);
  });

  it("refuses an earned spacing that is not a number of milliseconds", () => {
    expect(
      () =>
        new HostGate({
          perHostDelayMs: 100,
          robotsCrawlDelaySec: null,
          earnedSpacingMs: -1,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new HostGate({
          perHostDelayMs: 100,
          robotsCrawlDelaySec: null,
          earnedSpacingMs: Number.NaN,
        }),
    ).toThrow(RangeError);
  });

  // --- the PER-HOST earned spacing a resumed crawl carries back in (P13-T3) ---

  it("exports each touched host's high-water spacing as a map", () => {
    // The gate GROWS this so a resume can re-enter each host at its own earned
    // spacing rather than at the single crawl-wide widest. It reports the CURRENT
    // spacing per host — which, since escalations only ever rise, is that host's
    // high-water.
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    const throttle = (host: string, url: string) =>
      g.report(host, { fetchClass: "blocked", statusCode: 429, retryAfterMs: null, url });

    // A CDN pushes back three times (→ 8s); the origin never does (→ base 1s).
    throttle("cdn.example", "https://cdn.example/a");
    throttle("cdn.example", "https://cdn.example/b");
    throttle("cdn.example", "https://cdn.example/c");
    // Touch the origin so it enters the map at its base.
    g.report("origin.example", { fetchClass: "ok", statusCode: 200, retryAfterMs: null, url: "https://origin.example/" });

    expect(g.maxSpacingMsByHost()).toEqual({
      "cdn.example": 8000,
      "origin.example": 1000,
    });
    // A host nobody touched is not in the map — it has earned nothing.
    expect(g.maxSpacingMsByHost()["other.example"]).toBeUndefined();
  });

  it("bumps a spacing generation when ANY host moves, so a non-widest host's write fires", () => {
    // The loop persists the per-host map when this counter changes rather than
    // when the crawl-wide widest does — otherwise a non-widest host that
    // escalated could be left stale for a resume to re-enter too fast (rule 9).
    const g = new HostGate({ perHostDelayMs: 100, robotsCrawlDelaySec: null });
    const throttle = (host: string, url: string) =>
      g.report(host, { fetchClass: "blocked", statusCode: 429, retryAfterMs: null, url });

    // A wide host takes the crawl-wide widest first.
    throttle("wide.example", "https://wide.example/a");
    throttle("wide.example", "https://wide.example/b");
    const widest = g.maxSpacingMs();
    const genAfterWide = g.spacingGeneration();

    // A DIFFERENT host escalates but stays below the widest: the widest does NOT
    // move, yet the generation MUST — that is the write the fix depends on.
    throttle("narrow.example", "https://narrow.example/a");
    expect(g.maxSpacingMs()).toBe(widest); // widest unchanged
    expect(g.spacingGeneration()).toBeGreaterThan(genAfterWide); // but a host moved

    // A plain success moves nothing and does not bump the counter.
    const genBefore = g.spacingGeneration();
    g.report("narrow.example", { fetchClass: "ok", statusCode: 200, retryAfterMs: null, url: "https://narrow.example/ok" });
    expect(g.spacingGeneration()).toBe(genBefore);

    // raiseHostFloor that actually raises a base bumps it too; a no-op does not.
    g.raiseHostFloor("narrow.example", 5000);
    expect(g.spacingGeneration()).toBeGreaterThan(genBefore);
    const genAfterRaise = g.spacingGeneration();
    g.raiseHostFloor("narrow.example", 1); // below the current base — no-op
    expect(g.spacingGeneration()).toBe(genAfterRaise);
  });

  it("re-enters each host at ITS OWN earned spacing, not the crawl-wide widest", () => {
    // The whole point of the per-host map: a crawl whose CDN earned 8s while the
    // origin stayed at 1s resumes the origin at 1s, NOT at 8s.
    const g = new HostGate({
      perHostDelayMs: 1000,
      robotsCrawlDelaySec: null,
      earnedSpacingByHost: { "cdn.example": 8000, "origin.example": 1000 },
    });
    expect(g.spacingMs("cdn.example")).toBe(8000);
    expect(g.spacingMs("origin.example")).toBe(1000);
  });

  it("falls back to the crawl-wide earned spacing for a host not in the map", () => {
    // A host the prior run never recorded (a URL discovered only on the
    // continuation) has no per-host number, so it takes the crawl-wide widest —
    // the polite direction — and then the config floor when there is no map at
    // all (a pre-0015 row).
    const mapped = new HostGate({
      perHostDelayMs: 1000,
      robotsCrawlDelaySec: null,
      earnedSpacingMs: 8000,
      earnedSpacingByHost: { "cdn.example": 8000 },
    });
    expect(mapped.spacingMs("cdn.example")).toBe(8000);
    // Not in the map → the crawl-wide widest, exactly as before per-host existed.
    expect(mapped.spacingMs("fresh.example")).toBe(8000);
    expect(mapped.effectiveDelayMs()).toBe(8000);

    // A pre-0015 row: null map, and the crawl-wide value carries every host.
    const preNull = new HostGate({
      perHostDelayMs: 1000,
      robotsCrawlDelaySec: null,
      earnedSpacingMs: 8000,
      earnedSpacingByHost: null,
    });
    expect(preNull.spacingMs("anything.example")).toBe(8000);
  });

  it("keeps the fold pairings per host: config floor, robots, and the 30s cap all still win", () => {
    // The T3-P12 fold survives the per-host path. Each host's base is
    // max(config, robots, thisHostEarned), capped at 30s.
    const g = new HostGate({
      perHostDelayMs: 2000,
      robotsCrawlDelaySec: 3,
      earnedSpacingByHost: { "low.example": 500, "high.example": 90_000 },
    });
    // The config floor (2000) and robots (3000) both beat this host's tiny
    // earned 500 — the widest wins, per host.
    expect(g.spacingMs("low.example")).toBe(3000);
    // The cap binds a per-host earned exactly as it binds the crawl-wide one.
    expect(g.spacingMs("high.example")).toBe(30_000);
  });

  it("refuses a per-host earned spacing that is not a number of milliseconds", () => {
    expect(
      () =>
        new HostGate({
          perHostDelayMs: 100,
          robotsCrawlDelaySec: null,
          earnedSpacingByHost: { "a.example": -1 },
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new HostGate({
          perHostDelayMs: 100,
          robotsCrawlDelaySec: null,
          earnedSpacingByHost: { "a.example": Number.NaN },
        }),
    ).toThrow(RangeError);
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

  // --- the per-host floor (P11-T2: a third-party asset host's own rules) ---

  it("raises one host's base spacing and leaves every other host alone", async () => {
    const g = new HostGate({ perHostDelayMs: 50, robotsCrawlDelaySec: null });
    g.raiseHostFloor("cdn.example", 400);
    expect(g.spacingMs("cdn.example")).toBe(400);
    expect(g.spacingMs("a.example")).toBe(50);
    // The configured spacing is the crawl's; the floor is that host's, and the
    // lease sizing has to see the wider of the two.
    expect(g.effectiveDelayMs()).toBe(50);
    expect(g.maxSpacingMs()).toBe(400);
  });

  it("never lowers a floor, and never lifts one past maxDelayMs", () => {
    const g = new HostGate({
      perHostDelayMs: 100,
      robotsCrawlDelaySec: null,
      maxDelayMs: 1000,
    });
    g.raiseHostFloor("cdn.example", 500);
    // A smaller number is not a new instruction: the wider spacing stands.
    g.raiseHostFloor("cdn.example", 10);
    expect(g.spacingMs("cdn.example")).toBe(500);
    // `Crawl-delay: 3600` is a header a misconfigured CDN can send.
    g.raiseHostFloor("cdn.example", 3_600_000);
    expect(g.spacingMs("cdn.example")).toBe(1000);
    expect(() => g.raiseHostFloor("cdn.example", -1)).toThrow(RangeError);
  });

  it("ratchets from the raised floor, not from the crawl's base", () => {
    const g = new HostGate({ perHostDelayMs: 100, robotsCrawlDelaySec: null });
    g.raiseHostFloor("cdn.example", 400);
    g.report("cdn.example", {
      fetchClass: "blocked",
      statusCode: 429,
      retryAfterMs: null,
      url: "https://cdn.example/a.png",
    });
    // The host asked for 400ms and then said "not at this rate": doubling its
    // own number is the polite reading, doubling the crawl's would be a
    // back-off to less than it had already asked for.
    expect(g.spacingMs("cdn.example")).toBe(800);
    expect(g.spacingMs("a.example")).toBe(100);
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
  /** A 429: a statement about our rate, true of the host. */
  const throttled = (url = "https://a.example/1") =>
    ({ fetchClass: "blocked", statusCode: 429, retryAfterMs: null, url }) as const;
  /** A 403: a statement about one URL, until the host repeats it. */
  const forbidden = (url = "https://a.example/1") =>
    ({ fetchClass: "blocked", statusCode: 403, retryAfterMs: null, url }) as const;
  const fine = (url = "https://a.example/ok") =>
    ({ fetchClass: "ok", statusCode: 200, retryAfterMs: null, url }) as const;

  it("doubles a host's spacing per 429, and leaves the base alone", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    expect(g.spacingMs("a.example")).toBe(1000);

    g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(2000);
    g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(4000);
    g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(8000);

    // The configured/robots base is a fact about the crawl's configuration and
    // never moves — only the live spacing does.
    expect(g.effectiveDelayMs()).toBe(1000);
    // And it is per host: nobody else pays for one host's WAF.
    expect(g.spacingMs("b.example")).toBe(1000);
  });

  it("escalates per 429 even when successes interleave", () => {
    // The alternating case: a site handing out 200, 429, 200, 429 is a site we
    // are still hitting too fast, and a rule keyed on CONSECUTIVE blocks would
    // stall at x2 for ever.
    const g = new HostGate({ perHostDelayMs: 500, robotsCrawlDelaySec: null });
    g.report("a.example", throttled());
    g.report("a.example", fine());
    g.report("a.example", throttled());
    g.report("a.example", fine());
    g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(4000);
  });

  it("ratchets: a success never buys the spacing back", () => {
    const g = new HostGate({ perHostDelayMs: 500, robotsCrawlDelaySec: null });
    g.report("a.example", throttled());
    g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(2000);

    g.report("a.example", fine());
    g.report("a.example", fine());
    expect(g.spacingMs("a.example")).toBe(2000);

    // And the next block escalates from where the ratchet stands, not from the
    // base: a bucket that tripped three times is not a bucket to probe gently.
    g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(4000);
  });

  it("caps the escalation at maxDelayMs", () => {
    const g = new HostGate({
      perHostDelayMs: 1000,
      robotsCrawlDelaySec: null,
      maxDelayMs: 5000,
    });
    for (let i = 0; i < 20; i += 1) g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(5000);
  });

  it("escalates a zero-delay crawl from a seed rather than doubling nothing", () => {
    // perHostDelayMs 0 is the configuration in which a 429 matters most, and
    // 0 * 2 is 0 — the ratchet would be a silent no-op.
    const g = new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null });
    expect(g.spacingMs("a.example")).toBe(0);
    g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(1000);
    g.report("a.example", throttled());
    expect(g.spacingMs("a.example")).toBe(2000);
  });

  it("reports the widest spacing in force, for lease sizing", () => {
    const g = new HostGate({ perHostDelayMs: 100, robotsCrawlDelaySec: null });
    expect(g.maxSpacingMs()).toBe(100);
    g.report("a.example", throttled());
    g.report("a.example", throttled());
    g.report("b.example", throttled());
    expect(g.maxSpacingMs()).toBe(400);
  });

  it("spaces the next acquisition by the escalated delay, not the base", async () => {
    const g = new HostGate({ perHostDelayMs: 20, robotsCrawlDelaySec: null });
    await g.acquire("a.example"); // cold host: admitted at once
    g.report("a.example", throttled()); // -> 40ms
    g.report("a.example", throttled()); // -> 80ms
    const t0 = Date.now();
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it("honours Retry-After as a floor under the escalated spacing", async () => {
    const g = new HostGate({ perHostDelayMs: 5, robotsCrawlDelaySec: null });
    await g.acquire("a.example");
    g.report("a.example", { ...throttled(), retryAfterMs: 120 });
    const t0 = Date.now();
    await g.acquire("a.example");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it("takes the escalated spacing when it is the longer of the two", async () => {
    const g = new HostGate({ perHostDelayMs: 60, robotsCrawlDelaySec: null });
    await g.acquire("a.example");
    // 60 -> 120 escalated, against a 1ms Retry-After: the floor loses.
    g.report("a.example", { ...throttled(), retryAfterMs: 1 });
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
      statusCode: 503,
      retryAfterMs: 365 * 24 * 3600 * 1000,
      url: "https://a.example/1",
    });
    const t0 = Date.now();
    await g.acquire("a.example");
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(40);
    expect(waited).toBeLessThan(2000);
  });

  it("refuses a nonsense Retry-After from our own parser loudly", () => {
    const g = new HostGate({ perHostDelayMs: 10, robotsCrawlDelaySec: null });
    expect(() =>
      g.report("a.example", { ...throttled(), retryAfterMs: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      g.report("a.example", { ...throttled(), retryAfterMs: Number.NaN }),
    ).toThrow(RangeError);
  });

  // --- the streak rule: a refusal that named no rate ---

  it("never escalates on one URL's own retries, however many times it 403s", () => {
    // THE REGRESSION THIS RULE EXISTS FOR. A single permanently forbidden URL
    // spends three retry attempts; escalating on those would put the whole
    // crawl at x8 for a refusal that was never about our rate.
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    for (let i = 0; i < 10; i += 1) {
      g.report("a.example", forbidden("https://a.example/admin"));
    }
    expect(g.spacingMs("a.example")).toBe(1000);
    expect(g.maxSpacingMs()).toBe(1000);
  });

  it("escalates on a 403 volley spanning more than one URL, at the third", () => {
    // The yellow.com.mt shape: the WAF hates the rate and answers 403 to
    // everything it is asked for.
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report("a.example", forbidden("https://a.example/1"));
    expect(g.spacingMs("a.example")).toBe(1000);
    g.report("a.example", forbidden("https://a.example/2"));
    expect(g.spacingMs("a.example")).toBe(1000);
    g.report("a.example", forbidden("https://a.example/3"));
    expect(g.spacingMs("a.example")).toBe(2000); // the third qualifies it
    g.report("a.example", forbidden("https://a.example/4"));
    expect(g.spacingMs("a.example")).toBe(4000); // and it keeps widening
  });

  it("needs two distinct URLs, not merely three responses", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report("a.example", forbidden("https://a.example/admin"));
    g.report("a.example", forbidden("https://a.example/admin"));
    g.report("a.example", forbidden("https://a.example/admin"));
    expect(g.spacingMs("a.example")).toBe(1000);
    // A second URL joining the volley is what turns it into evidence about the
    // host — and the streak is already three long, so it qualifies at once.
    g.report("a.example", forbidden("https://a.example/other"));
    expect(g.spacingMs("a.example")).toBe(2000);
  });

  it("a success resets the streak's progress but not the spacing earned", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report("a.example", forbidden("https://a.example/1"));
    g.report("a.example", forbidden("https://a.example/2"));
    g.report("a.example", forbidden("https://a.example/3"));
    expect(g.spacingMs("a.example")).toBe(2000);

    g.report("a.example", fine());
    // Earned spacing kept…
    expect(g.spacingMs("a.example")).toBe(2000);
    // …and the streak starts again from nothing: two more 403s do not qualify.
    g.report("a.example", forbidden("https://a.example/4"));
    g.report("a.example", forbidden("https://a.example/5"));
    expect(g.spacingMs("a.example")).toBe(2000);
    g.report("a.example", forbidden("https://a.example/6"));
    expect(g.spacingMs("a.example")).toBe(4000);
  });

  it("treats a bare 503 as pushback for the streak, but never as a rate on its own", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    const down = (url: string) =>
      ({ fetchClass: "server_error", statusCode: 503, retryAfterMs: null, url }) as const;

    // One broken 503 route must not tax the crawl, exactly as one 403 must not.
    g.report("a.example", down("https://a.example/down"));
    g.report("a.example", down("https://a.example/down"));
    expect(g.spacingMs("a.example")).toBe(1000);

    // An origin answering 503 across the site is a different fact.
    g.report("a.example", down("https://a.example/other"));
    expect(g.spacingMs("a.example")).toBe(2000);
  });

  it("a 503 that names a Retry-After escalates at once — it stated a rate", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report("a.example", {
      fetchClass: "server_error",
      statusCode: 503,
      retryAfterMs: 2000,
      url: "https://a.example/down",
    });
    expect(g.spacingMs("a.example")).toBe(2000);
  });

  it("a 200 between two 403s resets the streak, so neither is host-wide", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    for (let i = 0; i < 6; i += 1) {
      g.report("a.example", forbidden(`https://a.example/${i}`));
      g.report("a.example", fine());
    }
    expect(g.spacingMs("a.example")).toBe(1000);
  });
});

// --- Phase 24a: the bounded recovery, the two-strike lock, the throttle record ---

describe("HostGate recovery from back-off", () => {
  const H = "a.example";
  const throttled = (url = "https://a.example/t"): HostOutcome => ({
    fetchClass: "blocked",
    statusCode: 429,
    retryAfterMs: null,
    url,
  });
  const clean = (i = 0): HostOutcome => ({
    fetchClass: "ok",
    statusCode: 200,
    retryAfterMs: null,
    url: `https://a.example/p${i}`,
  });
  const cleans = (g: HostGate, n: number) => {
    for (let i = 0; i < n; i += 1) g.report(H, clean(i));
  };

  it("pins RECOVERY_STREAK at 50", () => {
    expect(RECOVERY_STREAK).toBe(50);
  });

  it("2 x 429 then RECOVERY_STREAK x 200 halves the spacing once", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report(H, throttled());
    g.report(H, throttled());
    expect(g.spacingMs(H)).toBe(4000);

    cleans(g, RECOVERY_STREAK - 1);
    expect(g.spacingMs(H)).toBe(4000); // one short: nothing yet
    g.report(H, clean());
    expect(g.spacingMs(H)).toBe(2000); // halved, once
    expect(g.throttleRecord()[H]?.recoveries).toBe(1);
    // The crawl-wide peak is kept for lease sizing; only the host moved down.
    expect(g.maxSpacingMs()).toBe(4000);
  });

  it("a recovery moves the spacing generation, so the loop re-persists it", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report(H, throttled());
    const gen = g.spacingGeneration();
    cleans(g, RECOVERY_STREAK);
    expect(g.spacingGeneration()).toBe(gen + 1);
  });

  it("an escalation after a recovery locks recovery for the rest of the crawl", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report(H, throttled());
    g.report(H, throttled());
    cleans(g, RECOVERY_STREAK); // → 2000, recoveries 1
    expect(g.throttleRecord()[H]?.recoveryLocked).toBe(false);
    g.report(H, throttled()); // strike two → 4000, locked
    expect(g.spacingMs(H)).toBe(4000);
    expect(g.throttleRecord()[H]?.recoveryLocked).toBe(true);

    cleans(g, 500);
    expect(g.spacingMs(H)).toBe(4000);
    expect(g.throttleRecord()[H]?.recoveries).toBe(1);
  });

  it("alternating 200/429 never recovers more than once (the token-bucket shape)", () => {
    const g = new HostGate({ perHostDelayMs: 100, robotsCrawlDelaySec: null });
    for (let i = 0; i < 200; i += 1) {
      g.report(H, clean(i));
      g.report(H, throttled());
    }
    expect(g.throttleRecord()[H]!.recoveries).toBeLessThanOrEqual(1);

    // And with clean bursts long enough to recover every time, it still recovers
    // exactly once, locks, and its spacing comes down at most once overall.
    const b = new HostGate({ perHostDelayMs: 100, robotsCrawlDelaySec: null });
    const seen: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      b.report(H, throttled());
      seen.push(b.spacingMs(H));
      cleans(b, RECOVERY_STREAK);
      seen.push(b.spacingMs(H));
    }
    expect(b.throttleRecord()[H]!.recoveries).toBe(1);
    expect(b.throttleRecord()[H]!.recoveryLocked).toBe(true);
    let downs = 0;
    for (let i = 1; i < seen.length; i += 1) if (seen[i]! < seen[i - 1]!) downs += 1;
    expect(downs).toBe(1);
  });

  it("a non-clean response breaks the clean streak", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report(H, throttled());
    cleans(g, RECOVERY_STREAK - 1);
    // A lone 403 (pushback that does not escalate) and a 500 are not clean.
    g.report(H, { fetchClass: "blocked", statusCode: 403, retryAfterMs: null, url: "https://a.example/x" });
    cleans(g, RECOVERY_STREAK - 1);
    g.report(H, { fetchClass: "server_error", statusCode: 500, retryAfterMs: null, url: "https://a.example/y" });
    cleans(g, RECOVERY_STREAK - 1);
    // A 200 that carries a Retry-After is not clean either.
    g.report(H, { fetchClass: "ok", statusCode: 200, retryAfterMs: 10, url: "https://a.example/z" });
    cleans(g, RECOVERY_STREAK - 1);
    // No status at all (a network error) is not clean.
    g.report(H, { fetchClass: "network_error", statusCode: null, retryAfterMs: null, url: "https://a.example/n" });
    cleans(g, RECOVERY_STREAK - 1);
    expect(g.spacingMs(H)).toBe(2000);
    expect(g.throttleRecord()[H]?.recoveries).toBe(0);
    // A 3xx IS clean: it completes the streak.
    g.report(H, { fetchClass: "redirect", statusCode: 301, retryAfterMs: null, url: "https://a.example/r" });
    expect(g.spacingMs(H)).toBe(1000);
  });

  it("a non-429 4xx is clean", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report(H, throttled());
    cleans(g, RECOVERY_STREAK - 1);
    g.report(H, { fetchClass: "client_error", statusCode: 404, retryAfterMs: null, url: "https://a.example/404" });
    expect(g.spacingMs(H)).toBe(1000);
    expect(g.throttleRecord()[H]?.recoveries).toBe(1);
  });

  it("descends one level per RECOVERY_STREAK, all the way to base, then locks on the next escalation", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report(H, throttled());
    g.report(H, throttled());
    g.report(H, throttled());
    expect(g.spacingMs(H)).toBe(8000);
    const seen: number[] = [];
    for (let step = 0; step < 3; step += 1) {
      cleans(g, RECOVERY_STREAK);
      seen.push(g.spacingMs(H));
    }
    expect(seen).toEqual([4000, 2000, 1000]);
    expect(g.throttleRecord()[H]).toMatchObject({ recoveries: 3, recoveryLocked: false });

    g.report(H, throttled()); // escalation after recovering → locked
    expect(g.spacingMs(H)).toBe(2000);
    expect(g.throttleRecord()[H]?.recoveryLocked).toBe(true);
    cleans(g, 500);
    expect(g.spacingMs(H)).toBe(2000);
    expect(g.throttleRecord()[H]?.recoveries).toBe(3);
  });

  it("never recovers below the host's base", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: 3 });
    cleans(g, 500);
    expect(g.spacingMs(H)).toBe(3000);
    expect(g.throttleRecord()[H]?.recoveries).toBe(0);

    g.report(H, throttled());
    cleans(g, RECOVERY_STREAK * 5);
    expect(g.spacingMs(H)).toBe(3000);
    expect(g.throttleRecord()[H]?.recoveries).toBe(1);
  });

  it("counts exactly what it was told", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report(H, throttled()); // 429 → escalation 1, 2000
    g.report(H, { ...throttled(), retryAfterMs: 5 }); // 429 + Retry-After → escalation 2, 4000
    g.report(H, { fetchClass: "server_error", statusCode: 503, retryAfterMs: 7, url: "https://a.example/s" }); // Retry-After → escalation 3, 8000
    g.report(H, { fetchClass: "ok", statusCode: 200, retryAfterMs: 9, url: "https://a.example/o" }); // Retry-After, not pushback: no escalation
    cleans(g, RECOVERY_STREAK); // recovery → 4000
    g.report("b.example", { fetchClass: "ok", statusCode: 200, retryAfterMs: null, url: "https://b.example/" });

    expect(g.throttleRecord()).toEqual({
      [H]: {
        responses429: 2,
        retryAfterSeen: 3,
        escalations: 3,
        recoveries: 1,
        recoveryLocked: false,
        peakSpacingMs: 8000,
        finalSpacingMs: 4000,
      },
      "b.example": {
        responses429: 0,
        retryAfterSeen: 0,
        escalations: 0,
        recoveries: 0,
        recoveryLocked: false,
        peakSpacingMs: 1000,
        finalSpacingMs: 1000,
      },
    });
  });
});

describe("HostGate snapshot and restore", () => {
  const H = "a.example";
  const throttled: HostOutcome = { fetchClass: "blocked", statusCode: 429, retryAfterMs: null, url: "https://a.example/t" };
  const clean: HostOutcome = { fetchClass: "ok", statusCode: 200, retryAfterMs: null, url: "https://a.example/" };
  const entry = (over: Record<string, unknown> = {}) => ({
    spacingMs: 100,
    baseMs: 100,
    responses429: 0,
    retryAfterSeen: 0,
    escalations: 0,
    recoveries: 0,
    recoveryLocked: false,
    peakSpacingMs: 100,
    ...over,
  });

  it("round-trips the escalation state, so a resumed host can still recover and still locks", () => {
    const g = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    g.report(H, throttled);
    g.report(H, throttled);
    g.report(H, throttled); // 8000
    for (let i = 0; i < RECOVERY_STREAK; i += 1) g.report(H, clean); // → 4000, recoveries 1
    const snap = g.snapshot();
    expect(snap[H]).toEqual({
      spacingMs: 4000,
      baseMs: 1000,
      responses429: 3,
      retryAfterSeen: 0,
      escalations: 3,
      recoveries: 1,
      recoveryLocked: false,
      peakSpacingMs: 8000,
    });
    // Through JSON, as the jsonb column carries it.
    const r = new HostGate({ perHostDelayMs: 1000, robotsCrawlDelaySec: null });
    r.restore(JSON.parse(JSON.stringify(snap)));
    expect(r.spacingMs(H)).toBe(4000);
    expect(r.throttleRecord()).toEqual(g.throttleRecord());
    expect(r.snapshot()).toEqual(snap);
    expect(r.maxSpacingMs()).toBe(8000);
    // Strike two after the resume still locks: the recovery was remembered.
    r.report(H, throttled);
    expect(r.throttleRecord()[H]?.recoveryLocked).toBe(true);
  });

  it("re-enters a restored host at its stored base and level, and recovers no lower than the base", () => {
    const g = new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null });
    g.restore({
      [H]: entry({ spacingMs: 160, baseMs: 40, responses429: 2, escalations: 2, peakSpacingMs: 160 }),
    });
    expect(g.spacingMs(H)).toBe(160);
    for (let i = 0; i < RECOVERY_STREAK; i += 1) g.report(H, clean);
    expect(g.spacingMs(H)).toBe(80);
  });

  it("a restored base still loses to a wider config floor", () => {
    const g = new HostGate({ perHostDelayMs: 500, robotsCrawlDelaySec: null });
    g.restore({ [H]: entry({ spacingMs: 80, baseMs: 40, escalations: 1, responses429: 1, peakSpacingMs: 80 }) });
    expect(g.spacingMs(H)).toBe(1000); // 500 base, one level
  });

  it("accepts the pre-24a {host: ms} map, and the earned spacing still binds", () => {
    const g = new HostGate({ perHostDelayMs: 0, robotsCrawlDelaySec: null });
    g.restore({ [H]: 250, "b.example": 40 });
    expect(g.spacingMs(H)).toBe(250);
    expect(g.spacingMs("b.example")).toBe(40);
    // The old map carried no escalation level, so the number is the host's base:
    // there is nothing to recover, and the earned spacing holds however clean.
    for (let i = 0; i < RECOVERY_STREAK * 3; i += 1) g.report(H, clean);
    expect(g.spacingMs(H)).toBe(250);
    expect(g.maxSpacingMs()).toBe(250);
  });

  it("accepts an empty map", () => {
    const g = new HostGate({ perHostDelayMs: 10, robotsCrawlDelaySec: null });
    g.restore({});
    expect(g.throttleRecord()).toEqual({});
  });

  it("throws on anything that is neither shape", () => {
    const g = () => new HostGate({ perHostDelayMs: 10, robotsCrawlDelaySec: null });
    expect(() => g().restore("{}")).toThrow(/host_spacing_jsonb/);
    expect(() => g().restore(null)).toThrow(/host_spacing_jsonb/);
    expect(() => g().restore([1, 2])).toThrow(/host_spacing_jsonb/);
    expect(() => g().restore({ [H]: -1 })).toThrow(/a\.example/);
    expect(() => g().restore({ [H]: "250" })).toThrow(/a\.example/);
    expect(() => g().restore({ [H]: { spacingMs: 100 } })).toThrow(/baseMs/);
    expect(() => g().restore({ [H]: entry({ recoveryLocked: "no" }) })).toThrow(/recoveryLocked/);
    expect(() => g().restore({ [H]: entry({ escalations: 1.5 }) })).toThrow(/escalations/);
    // More recoveries than escalations is impossible.
    expect(() => g().restore({ [H]: entry({ escalations: 1, recoveries: 2 }) })).toThrow(/recoveries/);
    // A lock with no recovery behind it is impossible: only strike two locks.
    expect(() =>
      g().restore({ [H]: entry({ escalations: 1, recoveries: 0, recoveryLocked: true }) }),
    ).toThrow(/recoveryLocked/);
    // The possible locked state still loads.
    expect(() =>
      g().restore({ [H]: entry({ escalations: 2, recoveries: 1, recoveryLocked: true }) }),
    ).not.toThrow();
    // A mixed map is neither shape.
    expect(() => g().restore({ [H]: 100, "b.example": entry() })).toThrow(/mix/);
  });

  it("refuses to restore over a gate that has already seen a host", () => {
    const g = new HostGate({ perHostDelayMs: 10, robotsCrawlDelaySec: null });
    g.report(H, clean);
    expect(() => g.restore({ [H]: 100 })).toThrow(/already/);
  });
});

describe("HostGate.acquire with an abort signal (Phase 27b, Ruling 2)", () => {
  it("wakes a waiting acquire within 100 ms of the abort, and says it was aborted", async () => {
    const gate = new HostGate({ perHostDelayMs: 5_000, robotsCrawlDelaySec: null });
    const ac = new AbortController();
    // The first claim is free (elapsed-time credit); the second waits 5 s.
    expect(await gate.acquire("a.example", ac.signal)).toBe(true);
    const waiting = gate.acquire("a.example", ac.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const abortedAt = Date.now();
    ac.abort();
    expect(await waiting).toBe(false);
    expect(Date.now() - abortedAt).toBeLessThan(100);
    // The aborted waiter's slot is not handed back: the next free slot is
    // still two spacings from the first claim, not one.
    expect(gate.msUntilFree("a.example")).toBeGreaterThan(5_000);
  });

  it("claims nothing for a signal that is already aborted", async () => {
    const gate = new HostGate({ perHostDelayMs: 5_000, robotsCrawlDelaySec: null });
    const ac = new AbortController();
    ac.abort();
    expect(await gate.acquire("b.example", ac.signal)).toBe(false);
    expect(gate.msUntilFree("b.example")).toBe(0);
  });

  it("without a signal it waits out the spacing exactly as before", async () => {
    const gate = new HostGate({ perHostDelayMs: 150, robotsCrawlDelaySec: null });
    await gate.acquire("c.example");
    const started = Date.now();
    // Typed `void` for the callers that pass no signal (the overload), so the
    // host probe, the renderer and the 404 probe compile and behave as before.
    const answer: void = await gate.acquire("c.example");
    void answer;
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("with a signal that never fires it answers true when the slot comes due", async () => {
    const gate = new HostGate({ perHostDelayMs: 150, robotsCrawlDelaySec: null });
    const ac = new AbortController();
    await gate.acquire("d.example", ac.signal);
    const started = Date.now();
    expect(await gate.acquire("d.example", ac.signal)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});

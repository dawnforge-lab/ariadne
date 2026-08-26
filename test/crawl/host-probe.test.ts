/**
 * The host-variant probe, against one fixture server that answers as several
 * hosts at once.
 *
 * Hermetic in both directions: the resolver is injected (every name answers
 * 127.0.0.1, so no test ever depends on `www.localhost` existing on the
 * machine running it) and the server decides what to be from the `Host` header
 * it is sent. What is being tested is the *chain evidence* — one row per hop,
 * with the refusal or the network failure recorded rather than thrown.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { closeFetchAgents, type DnsLookupFn } from "../../src/crawl/http.js";
import {
  hostProbeStarts,
  probeHostVariants,
  MAX_HOST_PROBE_HOPS,
} from "../../src/crawl/host-probe.js";

let server: Server;
let port = 0;

/** Every hostname answers 127.0.0.1: the fixture server is the whole internet. */
const lookup: DnsLookupFn = (_hostname, options, callback) => {
  if (options.all === true) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};

function opts(extra: { legacyHosts?: string[]; perHostDelayMs?: number } = {}) {
  return {
    userAgent: "AriadneBot-test",
    allowPrivate: true,
    lookup,
    timeoutMs: 5_000,
    // Unpaced by default: the pacing test below sets a real delay, and every
    // other case is about the recorded evidence, not the clock.
    perHostDelayMs: 0,
    ...extra,
  };
}

const html = `<!doctype html><html><head><title>t</title></head><body><p>home</p></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const path = req.url ?? "/";
    if (host === "www.site.test" || host === "legacy.test") {
      res.writeHead(301, { location: `http://site.test:${port}/` });
      res.end();
      return;
    }
    if (host === "loop.test") {
      // Never terminates: every hop is another redirect one path segment on.
      res.writeHead(302, { location: `http://loop.test:${port}${path}x` });
      res.end();
      return;
    }
    if (host === "bad.test") {
      // A Location the URL policy refuses even under allowPrivate.
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  port = typeof addr === "object" && addr !== null ? addr.port : 0;
});

afterAll(async () => {
  await closeFetchAgents();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("hostProbeStarts", () => {
  it("derives the four scheme x www spellings, port kept", () => {
    expect(hostProbeStarts("https://example.com/deep/page?x=1")).toEqual([
      "http://example.com/",
      "https://example.com/",
      "http://www.example.com/",
      "https://www.example.com/",
    ]);
    expect(hostProbeStarts("http://site.test:8080/")).toEqual([
      "http://site.test:8080/",
      "https://site.test:8080/",
      "http://www.site.test:8080/",
      "https://www.site.test:8080/",
    ]);
  });

  it("strips the www label when the site URL carries it", () => {
    expect(hostProbeStarts("https://www.example.com/")).toEqual([
      "http://example.com/",
      "https://example.com/",
      "http://www.example.com/",
      "https://www.example.com/",
    ]);
  });

  it("expands a bare legacy host to both schemes and keeps a URL as written", () => {
    expect(hostProbeStarts("https://new.example/", ["old.example"])).toEqual([
      "http://new.example/",
      "https://new.example/",
      "http://www.new.example/",
      "https://www.new.example/",
      "http://old.example/",
      "https://old.example/",
    ]);
    expect(hostProbeStarts("https://new.example/", ["http://old.example:81/x"])).toEqual([
      "http://new.example/",
      "https://new.example/",
      "http://www.new.example/",
      "https://www.new.example/",
      "http://old.example:81/",
    ]);
  });

  it("gives an IP-addressed site no www spelling", () => {
    // `www.203.0.113.7` names nothing; asking the resolver about it would put
    // a made-up name on the wire and could land the fetch on whatever some
    // wildcard DNS answers with.
    expect(hostProbeStarts("http://203.0.113.7:8080/")).toEqual([
      "http://203.0.113.7:8080/",
      "https://203.0.113.7:8080/",
    ]);
    expect(hostProbeStarts("http://[::1]/")).toEqual([
      "http://[::1]/",
      "https://[::1]/",
    ]);
  });

  it("never probes the same start twice", () => {
    expect(hostProbeStarts("https://new.example/", ["new.example"])).toEqual([
      "http://new.example/",
      "https://new.example/",
      "http://www.new.example/",
      "https://www.new.example/",
    ]);
  });

  it("throws on a legacy host it cannot read, rather than dropping it", () => {
    expect(() => hostProbeStarts("https://new.example/", ["not a host"])).toThrow(
      /legacyHosts/,
    );
    expect(() => hostProbeStarts("https://new.example/", ["ftp://old.example/"])).toThrow(
      /legacyHosts/,
    );
  });

  it("throws on a site URL that is not http(s)", () => {
    expect(() => hostProbeStarts("mailto:x@y.z")).toThrow(/siteUrl/);
  });
});

describe("probeHostVariants", () => {
  it("records each variant's chain, hop by hop", async () => {
    const result = await probeHostVariants(`http://site.test:${port}/`, opts());
    const byStart = new Map(result.variants.map((v) => [v.start, v]));
    expect([...byStart.keys()]).toEqual(hostProbeStarts(`http://site.test:${port}/`));

    const apex = byStart.get(`http://site.test:${port}/`);
    expect(apex?.hops).toEqual([
      {
        url: `http://site.test:${port}/`,
        statusCode: 200,
        fetchClass: "ok",
        location: null,
      },
    ]);
    expect(apex?.final).toBe(`http://site.test:${port}/`);

    // The www spelling redirects to the apex: two hops, and the second one is
    // the answer. This is the whole of CHECK-13's evidence.
    const www = byStart.get(`http://www.site.test:${port}/`);
    expect(www?.hops).toEqual([
      {
        url: `http://www.site.test:${port}/`,
        statusCode: 301,
        fetchClass: "redirect",
        location: `http://site.test:${port}/`,
      },
      {
        url: `http://site.test:${port}/`,
        statusCode: 200,
        fetchClass: "ok",
        location: null,
      },
    ]);
    expect(www?.final).toBe(`http://site.test:${port}/`);
  });

  it("records an unreachable variant as a classified hop, not an error", async () => {
    const result = await probeHostVariants(`http://site.test:${port}/`, opts());
    const https = result.variants.find(
      (v) => v.start === `https://site.test:${port}/`,
    );
    // TLS against a plaintext server: the variant does not serve https, which
    // is the fact CHECK-15 needs. Recorded, never thrown.
    expect(https?.hops).toHaveLength(1);
    expect(https?.hops[0]?.fetchClass).toBe("network_error");
    expect(https?.hops[0]?.statusCode).toBeNull();
    // Nothing answered, so there is no destination to name.
    expect(https?.final).toBeNull();
  });

  it("stops a redirect chain at the hop budget and says so", async () => {
    const result = await probeHostVariants(`http://loop.test:${port}/`, opts());
    const apex = result.variants.find((v) => v.start === `http://loop.test:${port}/`);
    expect(apex?.hops).toHaveLength(MAX_HOST_PROBE_HOPS);
    expect(apex?.hops.every((h) => h.fetchClass === "redirect")).toBe(true);
    expect(apex?.final).toBeNull(); // the chain never landed
  });

  it("records a refused redirect target as a terminal hop with no location", async () => {
    const result = await probeHostVariants(`http://bad.test:${port}/`, opts());
    const apex = result.variants.find((v) => v.start === `http://bad.test:${port}/`);
    expect(apex?.hops).toHaveLength(1);
    expect(apex?.hops[0]?.statusCode).toBe(302);
    expect(apex?.hops[0]?.fetchClass).toBe("redirect");
    // fetch-page dropped the link-local target; the hop is still evidence.
    expect(apex?.hops[0]?.location).toBeNull();
    expect(apex?.final).toBeNull();
  });

  it("paces its hops by perHostDelayMs, per host", async () => {
    // Four chains over two names, five requests in all. Keyed by host, the
    // gate owes: apex hop 1 free, apex hop 2 (the https spelling is the same
    // host) one delay, www hop 1 free, the www chain's hop into the apex
    // another delay, the https www spelling nothing more. Two waits minimum.
    const delay = 80;
    const t0 = Date.now();
    const result = await probeHostVariants(`http://site.test:${port}/`, {
      ...opts({ perHostDelayMs: delay }),
    });
    const elapsed = Date.now() - t0;

    expect(result.variants).toHaveLength(4);
    expect(elapsed).toBeGreaterThanOrEqual(2 * delay - 10);
  });

  it("probes legacy hosts alongside the site's own variants", async () => {
    const result = await probeHostVariants(
      `http://site.test:${port}/`,
      opts({ legacyHosts: [`http://legacy.test:${port}/`] }),
    );
    const legacy = result.variants.find(
      (v) => v.start === `http://legacy.test:${port}/`,
    );
    expect(legacy?.hops.map((h) => h.statusCode)).toEqual([301, 200]);
    expect(legacy?.final).toBe(`http://site.test:${port}/`);
  });
});

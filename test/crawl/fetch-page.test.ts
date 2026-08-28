import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { fetchPage, parseRetryAfter } from "../../src/crawl/fetch-page.js";
import { closeFetchAgents, type DnsLookupFn } from "../../src/crawl/http.js";

let server: Server;
let base: string;
let port: number;
const OPTS = { userAgent: "AriadneBot-test", allowPrivate: true };

/** The `accept-encoding` the last request to /echo-accept-encoding carried. */
let lastAcceptEncoding: string | undefined;

/** `<html>…</html>` padded to exactly `bytes`, so a length assertion is exact. */
function htmlOfSize(bytes: number): string {
  const shell = "<html><title>z</title></html>";
  return shell.slice(0, -7) + "x".repeat(bytes - shell.length) + "</html>";
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/gzip-ok") {
      // 200 html, gzipped on the wire. The decompressed length is what
      // htmlBytes must report — not the ~60 bytes that actually crossed it.
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.from(htmlOfSize(4096), "utf-8")));
    } else if (req.url === "/gzip-exactly-1mib") {
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.from(htmlOfSize(1024 * 1024), "utf-8")));
    } else if (req.url === "/gzip-bomb") {
      // ~5KB on the wire, 8MiB decompressed: under any wire-byte cap, far over
      // the body cap. The whole point of capping the inflated side.
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x61)));
    } else if (req.url === "/gzip-lying") {
      // Claims gzip, sends plain text. zlib refuses it (Z_DATA_ERROR).
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      res.end("<html><title>not actually gzip</title></html>");
    } else if (req.url === "/brotli") {
      // A coding we never advertised. The bytes are irrelevant — we cannot
      // decode the label, so we never look at them.
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "br");
      res.end(Buffer.from([0x1b, 0x00, 0x00, 0x00]));
    } else if (req.url === "/gzip-dies-midstream") {
      // Headers, then a partial gzip member, then the socket is destroyed —
      // the shape a reset connection, a dropped CDN edge or an origin crash
      // takes when the response was compressed. The inflater has been fed
      // valid bytes and is waiting for more that will never come.
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      res.write(gzipSync(Buffer.from(htmlOfSize(4096), "utf-8")).subarray(0, 30));
      setTimeout(() => res.socket?.destroy(), 20);
    } else if (req.url === "/gzip-dies-clean") {
      // The other half: a partial gzip member and then a CLEAN end of body.
      // zlib sees a truncated member (Z_BUF_ERROR) rather than a dead socket.
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.from(htmlOfSize(4096), "utf-8")).subarray(0, 30));
    } else if (req.url === "/gzip-identity") {
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "identity");
      res.end("<html><title>identity</title></html>");
    } else if (req.url === "/gzip-pdf") {
      // Gzipped non-HTML: drained unread, so no CPU is spent inflating it.
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.from("%PDF-")));
    } else if (req.url === "/echo-accept-encoding") {
      lastAcceptEncoding = req.headers["accept-encoding"] as string | undefined;
      res.setHeader("content-type", "text/html");
      res.end("<html></html>");
    } else if (req.url === "/ok") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("link", '<https://ex.com/canon>; rel="canonical"');
      res.setHeader("x-robots-tag", "noindex");
      res.end("<html><title>ok</title></html>");
    } else if (req.url === "/moved") {
      res.statusCode = 301;
      res.setHeader("location", "/ok");
      res.end();
    } else if (req.url === "/moved-js") {
      res.statusCode = 302;
      res.setHeader("location", "javascript:alert(1)");
      res.end();
    } else if (req.url === "/moved-file") {
      res.statusCode = 301;
      res.setHeader("location", "file:///etc/passwd");
      res.end();
    } else if (req.url === "/moved-protocol-relative") {
      res.statusCode = 302;
      res.setHeader("location", "//other.example.com/x");
      res.end();
    } else if (req.url === "/moved-nowhere") {
      res.statusCode = 302;
      res.end();
    } else if (req.url === "/big") {
      res.setHeader("content-type", "text/html");
      res.end("x".repeat(2 * 1024 * 1024));
    } else if (req.url === "/exactly-1mib") {
      res.setHeader("content-type", "text/html");
      res.end("x".repeat(1024 * 1024));
    } else if (req.url === "/pdf") {
      res.setHeader("content-type", "application/pdf");
      res.end("%PDF-");
    } else if (req.url === "/challenge") {
      res.statusCode = 403;
      res.end("<html>Attention Required! | Cloudflare</html>");
    } else if (req.url === "/cf-mitigated") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html");
      res.setHeader("cf-mitigated", "challenge");
      res.end("<html>nope</html>");
    } else if (req.url === "/unavailable") {
      res.statusCode = 503;
      res.setHeader("content-type", "text/html");
      res.end("<html>backend down</html>");
    } else if (req.url === "/unavailable-challenge") {
      res.statusCode = 503;
      res.setHeader("content-type", "text/html");
      res.end("<html><title>Just a moment...</title></html>");
    } else if (req.url === "/throttled") {
      res.statusCode = 429;
      res.setHeader("retry-after", "2");
      res.setHeader("content-type", "text/html");
      res.end("<html>slow down</html>");
    } else if (req.url === "/throttled-dated") {
      res.statusCode = 429;
      res.setHeader("retry-after", new Date(Date.now() + 90_000).toUTCString());
      res.end("slow down");
    } else if (req.url === "/throttled-garbage") {
      res.statusCode = 429;
      res.setHeader("retry-after", "soon-ish");
      res.end("slow down");
    } else if (req.url === "/throttled-past") {
      res.statusCode = 403;
      res.setHeader("retry-after", "Wed, 21 Oct 2015 07:28:00 GMT");
      res.end("no");
    } else if (req.url === "/unavailable-retry-after") {
      res.statusCode = 503;
      res.setHeader("retry-after", "30");
      res.setHeader("content-type", "text/html");
      res.end("<html>backend down</html>");
    } else if (req.url === "/not-found-retry-after") {
      // A 404 that carries the header anyway. It is not a throttle, and
      // nothing must slow down because of it.
      res.statusCode = 404;
      res.setHeader("retry-after", "600");
      res.end("nope");
    } else if (req.url === "/latin1") {
      res.setHeader("content-type", "text/html; charset=iso-8859-1");
      res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])); // <p>é</p>
    } else if (req.url === "/bogus-charset") {
      res.setHeader("content-type", "text/html; charset=not-a-real-charset");
      res.end("<html><title>bogus</title></html>");
    } else if (req.url === "/xhtml") {
      res.setHeader("content-type", "application/xhtml+xml");
      res.end("<html><title>xhtml</title></html>");
    } else if (req.url === "/multi-link") {
      res.setHeader("content-type", "text/html");
      res.setHeader("link", [
        '<https://ex.com/prev>; rel="prev"',
        '<https://ex.com/c2>; rel="canonical"',
      ]);
      res.end("<html></html>");
    } else if (req.url === "/no-canonical") {
      res.setHeader("content-type", "text/html");
      res.setHeader("link", '<https://ex.com/next>; rel="next"');
      res.end("<html></html>");
    } else if (req.url === "/dribble") {
      // Headers straight away, then one byte every 50ms and no end: fast
      // enough to keep undici's per-chunk bodyTimeout happy forever, which is
      // what the whole-operation deadline is for.
      res.setHeader("content-type", "text/html");
      res.write("<html>");
      const tick = setInterval(() => res.write("x"), 50);
      res.on("close", () => clearInterval(tick));
    } else if (req.url === "/hang") {
      // never responds
    } else if (req.url === "/boom") {
      res.statusCode = 500;
      res.end("err");
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await closeFetchAgents();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A hermetic stand-in for dns.lookup that always answers with one address. */
function fixedLookup(address: string): DnsLookupFn {
  const family = address.includes(":") ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-08-28T12:00:00.000Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120", NOW)).toEqual({ ms: 120_000, note: null });
    expect(parseRetryAfter("0", NOW)).toEqual({ ms: 0, note: null });
    expect(parseRetryAfter("  5  ", NOW)).toEqual({ ms: 5000, note: null });
  });

  it("reads an HTTP-date", () => {
    expect(parseRetryAfter("Fri, 28 Aug 2026 12:01:00 GMT", NOW)).toEqual({
      ms: 60_000,
      note: null,
    });
  });

  it("keeps a hostile delta-seconds readable rather than refusing it", () => {
    // A year. It is a number, so it is read as one — the CAP is the gate's
    // job, and this function's job is not to invent a policy of its own.
    const parsed = parseRetryAfter("31536000", NOW);
    expect(parsed.ms).toBe(31_536_000_000);
    expect(parsed.note).toBeNull();
  });

  it("ignores a date in the past, loudly", () => {
    const parsed = parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", NOW);
    expect(parsed.ms).toBe(0);
    expect(parsed.note).toContain("past");
  });

  it("ignores what it cannot read, loudly and never as a number", () => {
    for (const bad of ["soon", "-5", "1.5", "", "   ", "n/a", "Tue, 99 Xxx"]) {
      const parsed = parseRetryAfter(bad, NOW);
      expect(parsed.ms, `Retry-After: ${JSON.stringify(bad)}`).toBeNull();
      expect(parsed.note, `Retry-After: ${JSON.stringify(bad)}`).toContain(
        "Retry-After",
      );
    }
  });

  it("reads a bare number as seconds, never as a year", () => {
    // `Date.parse("2026")` is midnight on New Year's Day 2026. RFC 9110 says
    // this is 2026 seconds, and a lenient date parser reaching it would be a
    // back-off measured in months.
    expect(parseRetryAfter("2026", NOW)).toEqual({ ms: 2_026_000, note: null });
  });

  it("says nothing at all when there was no header", () => {
    expect(parseRetryAfter(null, NOW)).toEqual({ ms: null, note: null });
  });
});

describe("fetchPage", () => {
  it("classifies a 200 html page and parses headers", async () => {
    const r = await fetchPage(`${base}/ok`, OPTS);
    expect(r.fetchClass).toBe("ok");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("<title>ok</title>");
    expect(r.canonicalHeader).toBe("https://ex.com/canon");
    expect(r.xRobotsTag).toBe("noindex");
    expect(r.contentType).toBe("text/html; charset=utf-8");
    expect(r.htmlBytes).toBe(30);
    expect(r.redirectUrl).toBeNull();
    expect(r.disallowedReason).toBeNull();
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("does not follow redirects; resolves the target absolute", async () => {
    const r = await fetchPage(`${base}/moved`, OPTS);
    expect(r.fetchClass).toBe("redirect");
    expect(r.statusCode).toBe(301);
    expect(r.redirectUrl).toBe(`${base}/ok`);
    expect(r.body).toBeNull();
  });

  it("drops a redirect target the URL policy refuses, but keeps the hop", async () => {
    for (const path of ["/moved-js", "/moved-file"]) {
      const r = await fetchPage(`${base}${path}`, OPTS);
      // The redirect happened; that stays true. Only the target is dropped.
      expect(r.fetchClass, path).toBe("redirect");
      expect(r.statusCode, path).toBeGreaterThanOrEqual(300);
      expect(r.redirectUrl, path).toBeNull();
      expect(r.disallowedReason, path).toContain("refused");
      expect(r.disallowedReason, path).toContain("scheme");
    }
  });

  it("inherits the page scheme for a protocol-relative Location", async () => {
    const r = await fetchPage(`${base}/moved-protocol-relative`, OPTS);
    expect(r.fetchClass).toBe("redirect");
    expect(r.redirectUrl).toBe("http://other.example.com/x");
    expect(r.disallowedReason).toBeNull();
  });

  it("records a 3xx with no Location as a hop with nothing to enqueue", async () => {
    const r = await fetchPage(`${base}/moved-nowhere`, OPTS);
    expect(r.fetchClass).toBe("redirect");
    expect(r.redirectUrl).toBeNull();
    expect(r.disallowedReason).toContain("Location");
  });

  it("caps the body at 1MiB", async () => {
    const r = await fetchPage(`${base}/big`, OPTS);
    expect(r.fetchClass).toBe("too_large");
    expect(r.body).toBeNull();
    expect(r.htmlBytes).toBe(1024 * 1024);
  });

  it("accepts a body of exactly 1MiB", async () => {
    const r = await fetchPage(`${base}/exactly-1mib`, OPTS);
    expect(r.fetchClass).toBe("ok");
    expect(r.htmlBytes).toBe(1024 * 1024);
    expect(r.body?.length).toBe(1024 * 1024);
  });

  it("classifies non-html", async () => {
    expect((await fetchPage(`${base}/pdf`, OPTS)).fetchClass).toBe("non_html");
  });

  // Build-plan §7 "before the first real-site crawl", item 1. Every one of
  // these bites on the open internet and none of them on a fixture server that
  // does not compress.
  describe("gzip transport encoding", () => {
    it("asks for gzip", async () => {
      lastAcceptEncoding = undefined;
      const r = await fetchPage(`${base}/echo-accept-encoding`, OPTS);
      expect(r.fetchClass).toBe("ok");
      expect(lastAcceptEncoding).toBe("gzip");
    });

    it("inflates a gzipped page and reports the decompressed size", async () => {
      const r = await fetchPage(`${base}/gzip-ok`, OPTS);
      expect(r.fetchClass).toBe("ok");
      expect(r.body).toContain("<title>z</title>");
      expect(r.body?.length).toBe(4096);
      // Not the wire bytes: gzip of 4KB of 'x' is a couple of dozen bytes.
      expect(r.htmlBytes).toBe(4096);
    });

    it("accepts a gzipped body of exactly 1MiB decompressed", async () => {
      const r = await fetchPage(`${base}/gzip-exactly-1mib`, OPTS);
      expect(r.fetchClass).toBe("ok");
      expect(r.htmlBytes).toBe(1024 * 1024);
      expect(r.body?.length).toBe(1024 * 1024);
    });

    it("refuses a body that expands past the cap — classified, not truncated", async () => {
      const r = await fetchPage(`${base}/gzip-bomb`, OPTS);
      // The failure is classified. A page row holding the first MiB of a bomb
      // would read to every rule as a real 8MiB-of-nothing page.
      expect(r.fetchClass).toBe("too_large");
      expect(r.body).toBeNull();
      expect(r.htmlBytes).toBe(1024 * 1024);
      expect(r.statusCode).toBe(200);
    });

    it("classifies a content-encoding we never advertised, and names it", async () => {
      const r = await fetchPage(`${base}/brotli`, OPTS);
      // Its own class, NOT network_error: the failure is deterministic, and
      // network_error is the retry bucket. Asking a CDN that ignores
      // accept-encoding three times gets three identical non-answers.
      expect(r.fetchClass).toBe("unsupported_encoding");
      expect(r.body).toBeNull();
      expect(r.disallowedReason).toBe("unsupported content-encoding (br)");
    });

    it("classifies a body that claims gzip and is not", async () => {
      const r = await fetchPage(`${base}/gzip-lying`, OPTS);
      expect(r.fetchClass).toBe("network_error");
      expect(r.body).toBeNull();
    });

    /**
     * Regression, and the reason the inflater is wired with `stream.pipeline`
     * rather than `body.pipe(gunzip)`.
     *
     * `Readable.pipe` does not forward SOURCE errors to the destination, so a
     * body that died mid-stream left the inflater neither ended nor errored
     * and the capped read never settled: `fetchPage` hung past its own
     * deadline, the URL got NO classified row at all (hard rule 7), and the
     * worker's byte reservation was never released. Measured at >8s against
     * 77ms for the identical response without `content-encoding`.
     *
     * The assertion is on the wall clock as much as on the class: the bug was
     * not a wrong verdict, it was no verdict ever.
     */
    it("classifies a gzipped body that dies mid-stream, and does not hang", async () => {
      const started = Date.now();
      const r = await fetchPage(`${base}/gzip-dies-midstream`, {
        ...OPTS,
        timeoutMs: 2_000,
      });
      const elapsed = Date.now() - started;

      expect(r.fetchClass).toBe("network_error");
      expect(r.body).toBeNull();
      // Well inside the deadline: the socket death is what ends the read, not
      // a timer, and certainly not never.
      expect(elapsed).toBeLessThan(1_000);
    });

    it("classifies a truncated gzip member that ends cleanly", async () => {
      const r = await fetchPage(`${base}/gzip-dies-clean`, { ...OPTS, timeoutMs: 2_000 });
      // zlib's Z_BUF_ERROR. Stays `network_error` — a body that stopped early
      // is a transport failure and worth another attempt, unlike a coding we
      // were never able to read (see `unsupported_encoding`).
      expect(r.fetchClass).toBe("network_error");
      expect(r.body).toBeNull();
    });

    it("reads content-encoding: identity as no encoding", async () => {
      const r = await fetchPage(`${base}/gzip-identity`, OPTS);
      expect(r.fetchClass).toBe("ok");
      expect(r.body).toContain("identity");
    });

    it("still classifies a gzipped non-html body as non_html", async () => {
      const r = await fetchPage(`${base}/gzip-pdf`, OPTS);
      expect(r.fetchClass).toBe("non_html");
      expect(r.body).toBeNull();
    });
  });

  it("treats application/xhtml+xml as html", async () => {
    const r = await fetchPage(`${base}/xhtml`, OPTS);
    expect(r.fetchClass).toBe("ok");
    expect(r.body).toContain("xhtml");
  });

  it("discards the body of a non-html response", async () => {
    expect((await fetchPage(`${base}/pdf`, OPTS)).body).toBeNull();
  });

  it("classifies bot challenges as blocked", async () => {
    expect((await fetchPage(`${base}/challenge`, OPTS)).fetchClass).toBe("blocked");
  });

  it("classifies a cf-mitigated 200 as blocked", async () => {
    const r = await fetchPage(`${base}/cf-mitigated`, OPTS);
    expect(r.fetchClass).toBe("blocked");
    expect(r.body).toBeNull();
  });

  it("classifies a plain 503 as a server error, a challenge 503 as blocked", async () => {
    expect((await fetchPage(`${base}/unavailable`, OPTS)).fetchClass).toBe(
      "server_error",
    );
    expect(
      (await fetchPage(`${base}/unavailable-challenge`, OPTS)).fetchClass,
    ).toBe("blocked");
  });

  it("reads Retry-After off a throttle, in both header formats", async () => {
    const seconds = await fetchPage(`${base}/throttled`, OPTS);
    expect(seconds.fetchClass).toBe("blocked");
    expect(seconds.retryAfterMs).toBe(2000);
    expect(seconds.disallowedReason).toBeNull();

    const dated = await fetchPage(`${base}/throttled-dated`, OPTS);
    expect(dated.fetchClass).toBe("blocked");
    // ~90s, less whatever the round trip and the header's second-resolution
    // truncation cost. Bounded on both sides, loosely — this is a clock.
    expect(dated.retryAfterMs).toBeGreaterThan(80_000);
    expect(dated.retryAfterMs).toBeLessThanOrEqual(90_000);
  });

  it("reads Retry-After off a 503 too", async () => {
    const r = await fetchPage(`${base}/unavailable-retry-after`, OPTS);
    expect(r.fetchClass).toBe("server_error");
    expect(r.retryAfterMs).toBe(30_000);
  });

  it("ignores an unreadable Retry-After loudly, and never as a number", async () => {
    const r = await fetchPage(`${base}/throttled-garbage`, OPTS);
    expect(r.fetchClass).toBe("blocked");
    expect(r.retryAfterMs).toBeNull(); // not NaN, not 0
    expect(r.disallowedReason).toContain("Retry-After");
    expect(r.disallowedReason).toContain("soon-ish");
  });

  it("ignores a Retry-After naming a time in the past, and says so", async () => {
    const r = await fetchPage(`${base}/throttled-past`, OPTS);
    expect(r.fetchClass).toBe("blocked");
    expect(r.retryAfterMs).toBe(0);
    expect(r.disallowedReason).toContain("Retry-After");
  });

  it("does not read Retry-After off a class that is not a throttle", async () => {
    const r = await fetchPage(`${base}/not-found-retry-after`, OPTS);
    expect(r.fetchClass).toBe("client_error");
    expect(r.retryAfterMs).toBeNull();
    expect(r.disallowedReason).toBeNull();
  });

  it("carries no Retry-After when the response carried none", async () => {
    expect((await fetchPage(`${base}/challenge`, OPTS)).retryAfterMs).toBeNull();
    expect((await fetchPage(`${base}/ok`, OPTS)).retryAfterMs).toBeNull();
  });

  it("classifies 4xx/5xx", async () => {
    expect((await fetchPage(`${base}/nope`, OPTS)).fetchClass).toBe("client_error");
    expect((await fetchPage(`${base}/boom`, OPTS)).fetchClass).toBe("server_error");
  });

  it("decodes the body using the content-type charset", async () => {
    const r = await fetchPage(`${base}/latin1`, OPTS);
    expect(r.fetchClass).toBe("ok");
    expect(r.body).toBe("<p>é</p>");
  });

  it("falls back to utf-8 for an unusable charset label", async () => {
    const r = await fetchPage(`${base}/bogus-charset`, OPTS);
    expect(r.fetchClass).toBe("ok");
    expect(r.body).toContain("<title>bogus</title>");
  });

  it("reads the canonical out of a repeated Link header", async () => {
    expect((await fetchPage(`${base}/multi-link`, OPTS)).canonicalHeader).toBe(
      "https://ex.com/c2",
    );
    expect((await fetchPage(`${base}/no-canonical`, OPTS)).canonicalHeader).toBeNull();
  });

  it("classifies a timeout", async () => {
    const r = await fetchPage(`${base}/hang`, { ...OPTS, timeoutMs: 300 });
    expect(r.fetchClass).toBe("timeout");
    expect(r.statusCode).toBeNull();
    expect(r.body).toBeNull();
  });

  it("bounds the whole operation, not just each phase", async () => {
    const started = Date.now();
    const r = await fetchPage(`${base}/dribble`, { ...OPTS, timeoutMs: 400 });
    expect(r.fetchClass).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("classifies a refused connection as a network error", async () => {
    // Port 1 on loopback: nothing listens there.
    const r = await fetchPage("http://127.0.0.1:1/", { ...OPTS, timeoutMs: 2_000 });
    expect(r.fetchClass).toBe("network_error");
    expect(r.statusCode).toBeNull();
  });

  it("classifies an unresolvable host as a network error", async () => {
    const r = await fetchPage("http://example.invalid/", {
      userAgent: "x",
      lookup: (_h, _o, cb) => {
        const err: NodeJS.ErrnoException = new Error("getaddrinfo ENOTFOUND");
        err.code = "ENOTFOUND";
        cb(err, "");
      },
    });
    expect(r.fetchClass).toBe("network_error");
  });

  it("throws our own bugs instead of classifying them", async () => {
    // A newline in the configured user agent is a defect in our config, not a
    // fact about the target site. It must not become a network_error row.
    await expect(
      fetchPage(`${base}/ok`, { ...OPTS, userAgent: "Ariadne\r\nX-Evil: 1" }),
    ).rejects.toThrow(/user-agent/i);
  });

  it("refuses a disallowed URL without fetching", async () => {
    const r = await fetchPage("http://169.254.169.254/latest/meta-data/", {
      userAgent: "x",
    });
    expect(r.fetchClass).toBe("disallowed");
    expect(r.statusCode).toBeNull();
    // The literal is on the blocked-host list by name before the range check.
    expect(r.disallowedReason).toContain("169.254.169.254");
  });

  it("refuses a non-http scheme without fetching", async () => {
    const r = await fetchPage("file:///etc/passwd", { userAgent: "x" });
    expect(r.fetchClass).toBe("disallowed");
    expect(r.disallowedReason).toContain("scheme");
  });

  describe("connect-time resolved-address re-check", () => {
    it("refuses a public hostname that resolves to a loopback address", async () => {
      const r = await fetchPage(`http://sneaky.example.com:${port}/ok`, {
        userAgent: "AriadneBot-test",
        lookup: fixedLookup("127.0.0.1"),
      });
      expect(r.fetchClass).toBe("disallowed");
      expect(r.statusCode).toBeNull();
      expect(r.body).toBeNull();
      expect(r.disallowedReason).toContain("127.0.0.0/8");
      expect(r.disallowedReason).toContain("sneaky.example.com");
    });

    it("refuses a public hostname that resolves to the metadata address", async () => {
      const r = await fetchPage("http://metadata.goog/computeMetadata/v1/", {
        userAgent: "AriadneBot-test",
        lookup: fixedLookup("169.254.169.254"),
      });
      expect(r.fetchClass).toBe("disallowed");
      expect(r.disallowedReason).toContain("169.254.169.254");
    });

    it("refuses even under allowPrivate when the address is the metadata floor", async () => {
      const r = await fetchPage("http://metadata.goog/computeMetadata/v1/", {
        userAgent: "AriadneBot-test",
        allowPrivate: true,
        lookup: fixedLookup("169.254.169.254"),
      });
      expect(r.fetchClass).toBe("disallowed");
      expect(r.disallowedReason).toContain("169.254.169.254");
    });

    it("refuses an IPv4-mapped IPv6 answer in blocked space", async () => {
      const r = await fetchPage(`http://sneaky.example.com:${port}/ok`, {
        userAgent: "AriadneBot-test",
        lookup: fixedLookup("::ffff:127.0.0.1"),
      });
      expect(r.fetchClass).toBe("disallowed");
      expect(r.disallowedReason).toContain("127.0.0.0/8");
    });

    it("allowPrivate lets a private answer through, as the fixture server needs", async () => {
      const r = await fetchPage(`http://fixture.example.com:${port}/ok`, {
        userAgent: "AriadneBot-test",
        allowPrivate: true,
        lookup: fixedLookup("127.0.0.1"),
      });
      expect(r.fetchClass).toBe("ok");
      expect(r.body).toContain("<title>ok</title>");
    });
  });
});

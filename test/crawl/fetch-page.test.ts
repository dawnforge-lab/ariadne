import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { FetchAbortedError, fetchPage, MAX_BODY, parseRetryAfter } from "../../src/crawl/fetch-page.js";
import { analyzePage } from "../../src/crawl/parse/page-analyzer.js";
import { closeFetchAgents, type DnsLookupFn } from "../../src/crawl/http.js";
import { RESPONSE_HEADER_VALUE_CAP } from "../../src/crawl/response-headers.js";

let server: Server;
let base: string;
let port: number;
const OPTS = { userAgent: "AriadneBot-test", allowPrivate: true };

/** The `accept-encoding` the last request to /echo-accept-encoding carried. */
let lastAcceptEncoding: string | undefined;

/** Two hreflang alternates in one `Link` value (Phase 26c, Task 6). */
const HREFLANG_LINK =
  '<https://ex.com/de>; rel="alternate"; hreflang="de", <https://ex.com/en>; rel="alternate"; hreflang="en"';

/**
 * Forty alternates, over `RESPONSE_HEADER_VALUE_CAP` (2,048) in one value: the
 * stored copy is cut, the parsed pairs must not be (deviation 2).
 */
const LONG_HREFLANG_LINK = Array.from(
  { length: 40 },
  (_, i) => `<https://ex.com/locale-${String(i).padStart(2, "0")}/a-rather-long-path>; rel="alternate"; hreflang="l${i}"`,
).join(", ");

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
    } else if (req.url === "/gzip-exactly-2mib") {
      res.setHeader("content-type", "text/html");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.from(htmlOfSize(2 * 1024 * 1024), "utf-8")));
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
      // 2.5 MiB: over the 2 MiB cap.
      res.setHeader("content-type", "text/html");
      res.end("x".repeat(2.5 * 1024 * 1024));
    } else if (req.url === "/one-and-a-half-mib") {
      // 1.5 MiB: over the OLD 1 MiB cap, under the 2 MiB one. A real page, so
      // the analyser has something to read past the old cut-off.
      res.setHeader("content-type", "text/html");
      const shell = "<html><head><title>late title</title></head><body>";
      const tail = '<a href="/after-the-old-cap">late link</a></body></html>';
      res.end(shell + "x".repeat(1.5 * 1024 * 1024 - shell.length - tail.length) + tail);
    } else if (req.url === "/exactly-2mib") {
      res.setHeader("content-type", "text/html");
      res.end("x".repeat(2 * 1024 * 1024));
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
    } else if (req.url === "/link-hreflang") {
      res.setHeader("content-type", "text/html");
      res.setHeader("link", HREFLANG_LINK);
      res.end("<html></html>");
    } else if (req.url === "/link-hreflang-pdf") {
      res.setHeader("content-type", "application/pdf");
      res.setHeader("link", HREFLANG_LINK);
      res.end("%PDF-");
    } else if (req.url === "/link-hreflang-moved") {
      res.statusCode = 301;
      res.setHeader("location", "/ok");
      res.setHeader("link", HREFLANG_LINK);
      res.end();
    } else if (req.url === "/link-hreflang-long") {
      res.setHeader("content-type", "text/html");
      res.setHeader("link", LONG_HREFLANG_LINK);
      res.end("<html></html>");
    } else if (req.url === "/link-hreflang-many") {
      res.setHeader("content-type", "text/html");
      res.setHeader(
        "link",
        Array.from({ length: 205 }, (_, i) => `</l/${i}>; rel="alternate"; hreflang="x${i}"`).join(", "),
      );
      res.end("<html></html>");
    } else if (req.url === "/link-mixed") {
      res.setHeader("content-type", "text/html");
      res.setHeader("link", [
        '</p2>; rel="next", </de>; rel="Alternate Nofollow"; hreflang=de',
        '</nolang>; rel="alternate", </empty>; rel="alternate"; hreflang=""',
        '</c>; rel="canonical"; hreflang="fr"',
      ]);
      res.end("<html></html>");
    } else if (req.url === "/link-trailing-semicolons") {
      // Hand-written server configs end params with `;` (review I1).
      res.setHeader("content-type", "text/html");
      res.setHeader("link", [
        '<https://ex.com/c3>; rel="canonical";',
        '<https://ex.com/de>; rel="alternate"; hreflang="de";, <https://ex.com/en>; rel="alternate"; hreflang="en"; foo=',
      ]);
      res.end("<html></html>");
    } else if (req.url === "/link-empty-canonical-first") {
      res.setHeader("content-type", "text/html");
      res.setHeader("link", "<>; rel=canonical, <https://ex.com/c4>; rel=canonical");
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
    } else if (req.url === "/gone-with-headers") {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html");
      res.setHeader("x-custom-not-allowlisted", "x");
      res.end("<html>gone</html>");
    } else if (req.url === "/headers-then-stall") {
      // Status line and headers go out, the body never follows: the deadline
      // expires DURING the body.
      res.writeHead(200, { "content-type": "text/html", server: "stall-fixture" });
      res.write("<html>");
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

  it("keeps the cap at 2MiB (Phase 23, study D2)", () => {
    expect(MAX_BODY).toBe(2 * 1024 * 1024);
  });

  it("caps the body at 2MiB: a 2.5MiB page is too_large, and htmlBytes holds the cap", async () => {
    const r = await fetchPage(`${base}/big`, OPTS);
    expect(r.fetchClass).toBe("too_large");
    expect(r.statusCode).toBe(200);
    expect(r.body).toBeNull();
    // The byte count at which reading stopped — the cap itself. This is what
    // `pages.html_bytes` holds for a too_large row and what
    // `page.html-too-large` reports.
    expect(r.htmlBytes).toBe(2 * 1024 * 1024);
  });

  it("reads and analyses a 1.5MiB page that the old 1MiB cap refused", async () => {
    const r = await fetchPage(`${base}/one-and-a-half-mib`, OPTS);
    expect(r.fetchClass).toBe("ok");
    expect(r.htmlBytes).toBe(1.5 * 1024 * 1024);
    expect(r.body).not.toBeNull();
    const a = analyzePage(r.body!, `${base}/one-and-a-half-mib`);
    expect(a.title).toBe("late title");
    // A link past the old 1MiB cut-off is seen.
    expect(a.links.map((l) => l.href)).toContain(`${base}/after-the-old-cap`);
  });

  it("accepts a body of exactly 2MiB", async () => {
    const r = await fetchPage(`${base}/exactly-2mib`, OPTS);
    expect(r.fetchClass).toBe("ok");
    expect(r.htmlBytes).toBe(2 * 1024 * 1024);
    expect(r.body?.length).toBe(2 * 1024 * 1024);
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

    it("accepts a gzipped body of exactly 2MiB decompressed", async () => {
      const r = await fetchPage(`${base}/gzip-exactly-2mib`, OPTS);
      expect(r.fetchClass).toBe("ok");
      expect(r.htmlBytes).toBe(2 * 1024 * 1024);
      expect(r.body?.length).toBe(2 * 1024 * 1024);
    });

    it("refuses a body that expands past the cap — classified, not truncated", async () => {
      const r = await fetchPage(`${base}/gzip-bomb`, OPTS);
      // The failure is classified. A page row holding the first 2MiB of a bomb
      // would read to every rule as a real 8MiB-of-nothing page.
      expect(r.fetchClass).toBe("too_large");
      expect(r.body).toBeNull();
      expect(r.htmlBytes).toBe(2 * 1024 * 1024);
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

  it("reads a canonical and hreflang pairs whose params end in a semicolon (review I1)", async () => {
    const r = await fetchPage(`${base}/link-trailing-semicolons`, OPTS);
    expect(r.canonicalHeader).toBe("https://ex.com/c3");
    expect(r.headerHreflang).toEqual([
      { code: "de", href: "https://ex.com/de" },
      { code: "en", href: "https://ex.com/en" },
    ]);
  });

  it("skips an empty canonical URI and takes the next canonical (review I1b)", async () => {
    expect((await fetchPage(`${base}/link-empty-canonical-first`, OPTS)).canonicalHeader).toBe(
      "https://ex.com/c4",
    );
  });

  describe("hreflang from the Link header (Phase 26c)", () => {
    const PAIRS = [
      { code: "de", href: "https://ex.com/de" },
      { code: "en", href: "https://ex.com/en" },
    ];

    it("yields one pair per alternate with an hreflang", async () => {
      const r = await fetchPage(`${base}/link-hreflang`, OPTS);
      expect(r.fetchClass).toBe("ok");
      expect(r.headerHreflang).toEqual(PAIRS);
    });

    it("reads it on a non-HTML response and on a redirect", async () => {
      const pdf = await fetchPage(`${base}/link-hreflang-pdf`, OPTS);
      expect(pdf.fetchClass).toBe("non_html");
      expect(pdf.headerHreflang).toEqual(PAIRS);
      const moved = await fetchPage(`${base}/link-hreflang-moved`, OPTS);
      expect(moved.fetchClass).toBe("redirect");
      expect(moved.headerHreflang).toEqual(PAIRS);
    });

    it("parses the full header, not the stored copy cut at the cap", async () => {
      expect(LONG_HREFLANG_LINK.length).toBeGreaterThan(RESPONSE_HEADER_VALUE_CAP);
      const r = await fetchPage(`${base}/link-hreflang-long`, OPTS);
      expect(r.responseHeaders?.truncated).toContain("link");
      expect(r.headerHreflang).toHaveLength(40);
      expect(r.headerHreflang[39]).toEqual({
        code: "l39",
        href: "https://ex.com/locale-39/a-rather-long-path",
      });
    });

    it("keeps hrefs as written and caps the pairs at 200", async () => {
      const r = await fetchPage(`${base}/link-hreflang-many`, OPTS);
      expect(r.headerHreflang).toHaveLength(200);
      expect(r.headerHreflang[0]).toEqual({ code: "x0", href: "/l/0" });
      expect(r.headerHreflang[199]).toEqual({ code: "x199", href: "/l/199" });
    });

    it("takes rel as tokens, needs a non-empty hreflang, and leaves the canonical alone", async () => {
      const r = await fetchPage(`${base}/link-mixed`, OPTS);
      expect(r.headerHreflang).toEqual([{ code: "de", href: "/de" }]);
      expect(r.canonicalHeader).toBe("/c");
    });

    it("is empty when no response headers were classified", async () => {
      expect((await fetchPage(`${base}/ok`, OPTS)).headerHreflang).toEqual([]);
      const timedOut = await fetchPage(`${base}/hang`, { ...OPTS, timeoutMs: 300 });
      expect(timedOut.headerHreflang).toEqual([]);
    });
  });

  it("classifies a timeout", async () => {
    const r = await fetchPage(`${base}/hang`, { ...OPTS, timeoutMs: 300 });
    expect(r.fetchClass).toBe("timeout");
    expect(r.statusCode).toBeNull();
    expect(r.body).toBeNull();
  });

  it("stores allowlisted headers on a 404", async () => {
    const r = await fetchPage(`${base}/gone-with-headers`, OPTS);
    expect(r.fetchClass).toBe("client_error");
    expect(r.responseHeaders?.values["content-type"]).toEqual(["text/html"]);
    expect(r.responseHeaders?.values["x-custom-not-allowlisted"]).toBeUndefined();
  });

  it("keeps headers that arrived before a body timeout", async () => {
    const r = await fetchPage(`${base}/headers-then-stall`, { ...OPTS, timeoutMs: 400 });
    expect(r.fetchClass).toBe("timeout");
    expect(r.statusCode).toBeNull();
    expect(r.responseHeaders).not.toBeNull();
    expect(r.responseHeaders?.values["server"]).toEqual(["stall-fixture"]);
  });

  it("has no headers when nothing answered", async () => {
    const r = await fetchPage("http://127.0.0.1:1/", { ...OPTS, timeoutMs: 2_000 });
    expect(r.fetchClass).toBe("network_error");
    expect(r.responseHeaders).toBeNull();
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

describe("fetchPage signal (27b)", () => {
  let stall: Server;
  let stallBase: string;
  let seen = 0;

  beforeAll(async () => {
    stall = createServer((req, res) => {
      seen += 1;
      if (req.url === "/partial-identity") {
        // Headers and the first bytes, then silence: the body read is stalled.
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<html><title>partial</title>");
      } else if (req.url === "/partial-gzip") {
        // A valid prefix of a gzip stream (incompressible payload), never ended.
        const whole = gzipSync(randomBytes(64 * 1024));
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.write(whole.subarray(0, 4096));
      }
      // /stall: accept, never answer
    });
    await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
    const addr = stall.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    stallBase = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    stall.closeAllConnections();
    await new Promise<void>((r) => stall.close(() => r()));
  });

  it("rejects with FetchAbortedError when the signal aborts mid-request", async () => {
    const url = `${stallBase}/stall`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const err = await fetchPage(url, { ...OPTS, timeoutMs: 20_000, signal: controller.signal }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FetchAbortedError);
    expect((err as FetchAbortedError).url).toBe(url);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each(["/partial-identity", "/partial-gzip"])(
    "rejects with FetchAbortedError when the signal aborts during the body read (%s)",
    async (path) => {
      const url = `${stallBase}${path}`;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300); // well after headers + first bytes
      const started = Date.now();
      const err = await fetchPage(url, { ...OPTS, timeoutMs: 20_000, signal: controller.signal }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FetchAbortedError);
      expect((err as FetchAbortedError).url).toBe(url);
      expect(Date.now() - started).toBeLessThan(1_000);
    },
  );

  it("rejects an already-aborted signal without touching the server", async () => {
    const before = seen;
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchPage(`${stallBase}/stall`, { ...OPTS, signal: controller.signal }),
    ).rejects.toBeInstanceOf(FetchAbortedError);
    expect(seen).toBe(before);
  });

  it("still classifies the deadline as timeout when a signal is supplied but not aborted", async () => {
    const result = await fetchPage(`${stallBase}/stall`, {
      ...OPTS,
      timeoutMs: 200,
      signal: new AbortController().signal,
    });
    expect(result.fetchClass).toBe("timeout");
  });

  it("classifies the deadline as timeout with no signal at all", async () => {
    const result = await fetchPage(`${stallBase}/stall`, { ...OPTS, timeoutMs: 200 });
    expect(result.fetchClass).toBe("timeout");
  });

  it("throws a programmer error even when the caller's signal aborted in the same tick (28a T5)", async () => {
    // The resolver aborts the caller's signal and then fails with a TypeError:
    // our bug and the abort land together. The bug must surface, not be
    // reclassified as an abort (hard rule 7; the resources path, 27d F3).
    const controller = new AbortController();
    const bug = new TypeError("programmer error in the resolver");
    const err = await fetchPage("http://example.invalid/", {
      userAgent: "x",
      allowPrivate: true,
      signal: controller.signal,
      lookup: (_h, _o, cb) => {
        controller.abort();
        cb(bug, "");
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(FetchAbortedError);
    expect(err).toBeInstanceOf(TypeError);
  });
});

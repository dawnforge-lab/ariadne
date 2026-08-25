import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  closeFetchAgents,
  fetchPage,
  type DnsLookupFn,
} from "../../src/crawl/fetch-page.js";

let server: Server;
let base: string;
let port: number;
const OPTS = { userAgent: "AriadneBot-test", allowPrivate: true };

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("link", '<https://ex.com/canon>; rel="canonical"');
      res.setHeader("x-robots-tag", "noindex");
      res.end("<html><title>ok</title></html>");
    } else if (req.url === "/moved") {
      res.statusCode = 301;
      res.setHeader("location", "/ok");
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

import { describe, expect, it } from "vitest";
import { isCrawlableUrl, isUrlAllowed } from "../../src/crawl/url-policy.js";

describe("isUrlAllowed", () => {
  it("refuses non-http(s) schemes", async () => {
    expect((await isUrlAllowed("file:///etc/passwd")).allowed).toBe(false);
    expect((await isUrlAllowed("gopher://x/")).allowed).toBe(false);
  });

  it("refuses loopback, private and link-local literals", async () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://169.254.169.254/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      const v = await isUrlAllowed(u);
      expect(v.allowed, u).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });

  it("allows a public https URL", async () => {
    expect((await isUrlAllowed("https://example.com/")).allowed).toBe(true);
  });

  it("test-only allowPrivate admits loopback", async () => {
    expect(
      (await isUrlAllowed("http://127.0.0.1/", { allowPrivate: true })).allowed,
    ).toBe(true);
    expect(
      (await isUrlAllowed("http://localhost:8080/", { allowPrivate: true }))
        .allowed,
    ).toBe(true);
    expect(
      (await isUrlAllowed("http://[::1]:8080/", { allowPrivate: true })).allowed,
    ).toBe(true);
  });

  it("allowPrivate still cannot reach cloud metadata endpoints", async () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.170.2/",
      "http://100.100.100.200/",
      "http://metadata.google.internal/",
      "http://metadata/",
      // IPv4-mapped spellings of the metadata address must not step around
      // the floor. URL canonicalises the dotted form to the hex one.
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/",
      "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
    ]) {
      const v = await isUrlAllowed(u, { allowPrivate: true });
      expect(v.allowed, u).toBe(false);
      expect(v.reason, u).toBeTruthy();
    }
  });

  it("allowPrivate still refuses non-http schemes", async () => {
    expect(
      (await isUrlAllowed("file:///etc/passwd", { allowPrivate: true })).allowed,
    ).toBe(false);
  });

  it("does no network I/O — a public verdict is offline-safe", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("url-policy must not fetch on the hot path");
    };
    try {
      expect((await isUrlAllowed("https://example.com/")).allowed).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses unparseable URLs and internal host names", async () => {
    expect((await isUrlAllowed("not a url")).allowed).toBe(false);
    for (const u of [
      "http://localhost/",
      "http://box.local/",
      "http://svc.internal/",
      "http://metadata.google.internal/",
      "http://100.100.100.200/",
    ]) {
      expect((await isUrlAllowed(u)).allowed, u).toBe(false);
    }
  });

  it("refuses every spelling of a loopback IPv6 literal", async () => {
    for (const u of [
      "http://[0:0:0:0:0:0:0:1]/",
      "http://[0:0:0:0:0:ffff:7f00:1]/",
      "http://[::ffff:7f00:1]/",
      "http://[::127.0.0.1]/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
      "http://[ff02::1]/",
      "http://[64:ff9b::7f00:1]/",
    ]) {
      const v = await isUrlAllowed(u);
      expect(v.allowed, u).toBe(false);
      expect(v.reason, u).toBeTruthy();
    }
  });

  it("allows a global-unicast IPv6 literal", async () => {
    expect((await isUrlAllowed("http://[2606:4700::1111]/")).allowed).toBe(true);
  });

  it("refuses the private ranges upstream enumerated", async () => {
    for (const u of [
      "http://0.0.0.0/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://198.18.0.1/",
      "http://224.0.0.1/",
      "http://255.255.255.255/",
    ]) {
      expect((await isUrlAllowed(u)).allowed, u).toBe(false);
    }
    // Adjacent public space stays crawlable.
    for (const u of [
      "http://172.15.0.1/",
      "http://172.32.0.1/",
      "http://100.63.255.255/",
      "http://198.20.0.1/",
      "http://223.255.255.255/",
    ]) {
      expect((await isUrlAllowed(u)).allowed, u).toBe(true);
    }
  });

  it("refuses obfuscated loopback spellings that URL canonicalises", async () => {
    for (const u of [
      "http://2130706433/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://LOCALHOST/",
      "http://localhost./",
    ]) {
      expect((await isUrlAllowed(u)).allowed, u).toBe(false);
    }
  });

  it("carries a reason naming why the URL was refused", async () => {
    // The cloud metadata address is refused by name before the range check.
    expect(
      (await isUrlAllowed("http://169.254.169.254/latest/meta-data/")).reason,
    ).toContain("169.254.169.254");
    // Any other link-local address is refused by range.
    expect((await isUrlAllowed("http://169.254.1.1/")).reason).toContain(
      "169.254.0.0/16",
    );
    expect((await isUrlAllowed("gopher://x/")).reason).toContain("gopher:");
  });
});

describe("isCrawlableUrl", () => {
  it("agrees with the facade", () => {
    expect(isCrawlableUrl("https://example.com/")).toBe(true);
    expect(isCrawlableUrl("http://127.0.0.1/")).toBe(false);
    expect(isCrawlableUrl("ftp://example.com/")).toBe(false);
    expect(isCrawlableUrl("nonsense")).toBe(false);
  });
});

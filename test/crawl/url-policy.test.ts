import { describe, expect, it } from "vitest";
import {
  blockedAddressReason,
  isCrawlableUrl,
  isUrlAllowed,
  resolveApprovedAddress,
  UrlPolicyError,
  type AddressResolver,
} from "../../src/crawl/url-policy.js";

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

  /**
   * Build-plan §7 "before the first real-site crawl", item 5.
   *
   * 6to4 and Teredo addresses live inside 2000::/3, so the global-unicast
   * allowlist admitted them — while the address they actually reach is an IPv4
   * one written in their own bits. `2002:7f00:1::1` IS 127.0.0.1.
   *
   * Every literal below is derived by hand and its embedded IPv4 is shown, so
   * the test states the arithmetic rather than trusting the implementation to
   * agree with itself.
   */
  describe("6to4 and Teredo embeddings", () => {
    // 6to4 (RFC 3056 §2): 2002:<V4ADDR>::/48, the IPv4 in the clear at bits
    // 16-47. Read the two groups after 2002 as four bytes.
    const SIX_TO_FOUR = [
      ["http://[2002:7f00:1::1]/", "7f 00 00 01 = 127.0.0.1", "127.0.0.0/8"],
      ["http://[2002:c0a8:101::1]/", "c0 a8 01 01 = 192.168.1.1", "192.168.0.0/16"],
      ["http://[2002:a00:1::1]/", "0a 00 00 01 = 10.0.0.1", "10.0.0.0/8"],
      ["http://[2002:ac10:1::1]/", "ac 10 00 01 = 172.16.0.1", "172.16.0.0/12"],
      ["http://[2002:6440:1::1]/", "64 40 00 01 = 100.64.0.1", "100.64.0.0/10"],
      ["http://[2002:a9fe:a9fe::]/", "a9 fe a9 fe = 169.254.169.254", "169.254.0.0/16"],
    ] as const;

    // Teredo (RFC 4380 §4): 2001:0000 | server(clear) | flags | port^ffff |
    // client^ffffffff. Server 65.54.227.120 = 41 36 e3 78; flags 8000; port
    // 40000 = 9c40 ^ ffff = 63bf. Only the last two groups change below.
    const TEREDO_HEAD = "2001:0:4136:e378:8000:63bf";
    const TEREDO_CLIENTS = [
      // c0 a8 01 01 ^ ff = 3f 57 fe fe
      ["3f57:fefe", "192.168.1.1", "192.168.0.0/16"],
      // 7f 00 00 01 ^ ff = 80 ff ff fe
      ["80ff:fffe", "127.0.0.1", "127.0.0.0/8"],
      // 0a 00 00 01 ^ ff = f5 ff ff fe
      ["f5ff:fffe", "10.0.0.1", "10.0.0.0/8"],
      // ac 10 00 01 ^ ff = 53 ef ff fe
      ["53ef:fffe", "172.16.0.1", "172.16.0.0/12"],
      // a9 fe a9 fe ^ ff = 56 01 56 01
      ["5601:5601", "169.254.169.254", "169.254.0.0/16"],
    ] as const;

    // 08 08 08 08 ^ ff = f7 f7 f7 f7 — a public client, on a public server.
    const TEREDO_PUBLIC = `http://[${TEREDO_HEAD}:f7f7:f7f7]/`;

    it("refuses a 6to4 address whose embedded IPv4 is refused", async () => {
      for (const [url, embedded, range] of SIX_TO_FOUR) {
        const v = await isUrlAllowed(url);
        expect(v.allowed, `${url} embeds ${embedded}`).toBe(false);
        // The refusal names the embedding, so a reader is not left wondering
        // why a 2000::/3 address was turned away.
        expect(v.reason, url).toContain("6to4");
        expect(v.reason, url).toContain(range);
      }
    });

    it("refuses a Teredo address whose de-obfuscated client IPv4 is refused", async () => {
      for (const [group, client, range] of TEREDO_CLIENTS) {
        const url = `http://[${TEREDO_HEAD}:${group}]/`;
        const v = await isUrlAllowed(url);
        expect(v.allowed, `${url} embeds client ${client}`).toBe(false);
        expect(v.reason, url).toContain("Teredo");
        expect(v.reason, url).toContain("client");
        expect(v.reason, url).toContain(range);
      }
    });

    it("refuses a Teredo address whose server IPv4 is refused", async () => {
      // Server 10.0.0.1 = 0a 00 00 01 -> groups a00:1; client stays 8.8.8.8.
      const url = `http://[2001:0:a00:1:8000:63bf:f7f7:f7f7]/`;
      const v = await isUrlAllowed(url);
      expect(v.allowed).toBe(false);
      expect(v.reason).toContain("Teredo");
      // Named as the server, not mistaken for the client — the two fields are
      // different things and the reason has to say which one failed.
      expect(v.reason).toContain("server");
      expect(v.reason).toContain("10.0.0.0/8");
    });

    it("still allows 6to4 and Teredo addresses embedding public IPv4", async () => {
      // 08 08 08 08 = 8.8.8.8, and 5d b8 d8 22 = 93.184.216.34.
      expect((await isUrlAllowed("http://[2002:808:808::1]/")).allowed).toBe(true);
      expect((await isUrlAllowed("http://[2002:5db8:d822::1]/")).allowed).toBe(true);
      expect((await isUrlAllowed(TEREDO_PUBLIC)).allowed).toBe(true);
    });

    it("leaves ordinary 2001::/16 global unicast alone", async () => {
      // Only 2001:0000::/32 is Teredo. Google's resolver is not, and neither
      // is any other 2001: allocation — a /16-wide match would have refused
      // a large slice of the real IPv6 internet.
      expect((await isUrlAllowed("http://[2001:4860:4860::8888]/")).allowed).toBe(true);
      expect((await isUrlAllowed("http://[2001:500:200::b]/")).allowed).toBe(true);
    });

    it("catches the embeddings in every spelling of the literal", async () => {
      // Uncompressed, and with the compression in a different place: the byte
      // parser is the authority, so no spelling escapes.
      for (const u of [
        "http://[2002:7f00:0001:0000:0000:0000:0000:0001]/",
        "http://[2002:7f00:1:0:0:0:0:1]/",
        "http://[2001:0000:4136:e378:8000:63bf:3f57:fefe]/",
      ]) {
        expect((await isUrlAllowed(u)).allowed, u).toBe(false);
      }
    });
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

describe("blockedAddressReason", () => {
  it("refuses every spelling of a blocked address", () => {
    for (const a of [
      "127.0.0.1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:127.0.0.1",
      "10.0.0.5",
      "169.254.169.254",
      "fd00::1",
      "::1",
    ]) {
      expect(blockedAddressReason(a), a).not.toBeNull();
    }
  });

  it("admits a public address", () => {
    expect(blockedAddressReason("93.184.216.34")).toBeNull();
    expect(blockedAddressReason("2606:2800:220:1:248:1893:25c8:1946")).toBeNull();
  });

  it("allowPrivate relaxes to the metadata floor and no further", () => {
    expect(blockedAddressReason("127.0.0.1", { allowPrivate: true })).toBeNull();
    expect(blockedAddressReason("10.0.0.5", { allowPrivate: true })).toBeNull();
    // The floor allowPrivate cannot lift.
    expect(
      blockedAddressReason("169.254.169.254", { allowPrivate: true }),
    ).not.toBeNull();
    expect(
      blockedAddressReason("::ffff:169.254.169.254", { allowPrivate: true }),
    ).not.toBeNull();
  });

  it("re-checks a resolved 6to4 / Teredo address on its embedded IPv4", () => {
    // The connect-time counterpart: an AAAA answer can be a 6to4 or Teredo
    // address just as easily as a URL can, and this is the check that sees the
    // address DNS actually returned.
    expect(blockedAddressReason("2002:7f00:1::1")).not.toBeNull(); // 127.0.0.1
    expect(blockedAddressReason("2002:c0a8:101::1")).not.toBeNull(); // 192.168.1.1
    expect(
      blockedAddressReason("2001:0:4136:e378:8000:63bf:3f57:fefe"),
    ).not.toBeNull(); // client 192.168.1.1
    // Public embeddings still resolve to a crawlable address.
    expect(blockedAddressReason("2002:808:808::1")).toBeNull(); // 8.8.8.8
    expect(blockedAddressReason("2001:0:4136:e378:8000:63bf:f7f7:f7f7")).toBeNull();
  });

  it("keeps the metadata floor closed against a tunnelled 169.254.169.254", () => {
    // allowPrivate is allowed to admit 6to4-wrapped loopback, exactly as it
    // admits plain 127.0.0.1 — the fixture server is the whole point of it.
    expect(blockedAddressReason("2002:7f00:1::1", { allowPrivate: true })).toBeNull();
    // But the floor is not a policy the hatch can relax, and a spelling the
    // floor could not read would be a hole in it. a9 fe a9 fe = 169.254.169.254,
    // and 56 01 56 01 is the same address XOR ff.
    expect(
      blockedAddressReason("2002:a9fe:a9fe::", { allowPrivate: true }),
    ).not.toBeNull();
    expect(
      blockedAddressReason("2001:0:4136:e378:8000:63bf:5601:5601", {
        allowPrivate: true,
      }),
    ).not.toBeNull();
  });

  it("refuses an unparseable answer rather than admitting it", () => {
    expect(blockedAddressReason("")).not.toBeNull();
    // A resolver answer that is not an IP literal is an anomaly, not a pass.
    expect(blockedAddressReason("not-an-address")).not.toBeNull();
    expect(blockedAddressReason("10..0.1")).not.toBeNull();
    expect(
      blockedAddressReason("not-an-address", { allowPrivate: true }),
    ).not.toBeNull();
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

describe("resolveApprovedAddress", () => {
  const answers =
    (a: string[], aaaa: string[] = []): AddressResolver =>
    async (_host, type) =>
      type === "A" ? a : aaaa;

  it("returns an IP literal as its own address, checked as one", async () => {
    await expect(resolveApprovedAddress("203.0.113.7")).resolves.toBe("203.0.113.7");
    await expect(resolveApprovedAddress("[2606:2800:220:1::1]")).resolves.toBe("2606:2800:220:1::1");
    await expect(resolveApprovedAddress("[::1]")).rejects.toThrow(/loopback/);
    await expect(resolveApprovedAddress("10.0.0.1")).rejects.toThrow(/private IPv4/);
  });

  it("pins a name to its first approved IPv4, else its first IPv6", async () => {
    await expect(
      resolveApprovedAddress("shop.example", {
        resolve: answers(["93.184.216.34", "93.184.216.35"], ["2606:2800:220:1::1"]),
      }),
    ).resolves.toBe("93.184.216.34");
    await expect(
      resolveApprovedAddress("shop.example", { resolve: answers([], ["2606:2800:220:1::1"]) }),
    ).resolves.toBe("2606:2800:220:1::1");
  });

  it("refuses a name with ANY answer in blocked space, and one with none", async () => {
    await expect(
      resolveApprovedAddress("shop.example", { resolve: answers(["93.184.216.34", "10.0.0.5"]) }),
    ).rejects.toThrow(/resolves into blocked address space \(10\.0\.0\.5/);
    await expect(
      resolveApprovedAddress("shop.example", { resolve: answers([]) }),
    ).rejects.toThrow(/no A or AAAA record/);
    await expect(resolveApprovedAddress("metadata.google.internal")).rejects.toThrow(/blocked/);
  });

  it("says only that a name could not be resolved when the resolver fails, keeping its text on cause", async () => {
    // Fix round 4: the resolver's own message names the DoH transport and
    // whatever sat between us and Cloudflare. That is operator detail, not a
    // fact about the caller's site, so the thrown message carries none of it
    // and `cause` carries all of it for the server log.
    const dohDown: AddressResolver = async (host, type) => {
      throw new UrlPolicyError(
        "DNS_RESOLUTION_FAILED",
        `DoH ${type} lookup for ${host} failed: TypeError: fetch failed (ECONNREFUSED 10.0.0.53:443)`,
      );
    };
    const error: unknown = await resolveApprovedAddress("shop.example", { resolve: dohDown }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(UrlPolicyError);
    const policy = error as UrlPolicyError;
    expect(policy.code).toBe("DNS_RESOLUTION_FAILED");
    expect(policy.message).toBe("shop.example could not be resolved");
    expect(policy.cause).toBeInstanceOf(UrlPolicyError);
    expect((policy.cause as Error).message).toMatch(/^DoH A lookup for shop\.example failed: TypeError: fetch failed/);
  });

  it("passes a resolver defect through untouched rather than dressing it as a DNS answer", async () => {
    // Rule 7: a resolver that throws a plain Error is broken, not "unresolved".
    const defect = new Error("resolver exploded");
    await expect(
      resolveApprovedAddress("shop.example", {
        resolve: async () => {
          throw defect;
        },
      }),
    ).rejects.toBe(defect);
  });

  it("relaxes only to the floor under the test-only allowPrivate", async () => {
    await expect(
      resolveApprovedAddress("shop.test", { allowPrivate: true, resolve: answers(["127.0.0.1"]) }),
    ).resolves.toBe("127.0.0.1");
    await expect(
      resolveApprovedAddress("shop.test", {
        allowPrivate: true,
        resolve: answers(["169.254.169.254"]),
      }),
    ).rejects.toThrow(/blocked/);
  });
});

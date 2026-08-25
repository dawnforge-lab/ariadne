/**
 * Adapted from open-seo (MIT), src/server/lib/audit/url-policy.test.ts
 * @ c469a48ae90ab58413b198fe3d1ac1aa90a9b070.
 * Changes: imports rewritten to this repo's paths; AppError -> UrlPolicyError
 * (the `code` field is unchanged, so the assertions are untouched);
 * "returns the last URL when the probe fails" now rejects only the HEAD probe
 * and keeps DoH answering, because a DoH failure is no longer swallowed
 * (see url-policy.ts). Every test stubs global fetch — the suite must never
 * touch the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
  type UrlPolicyError,
} from "./url-policy.js";

const dnsOk = () =>
  new Response(JSON.stringify({ Status: 0, Answer: [] }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
const redirect = (location: string) =>
  new Response(null, { status: 301, headers: { location } });

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

describe("normalizeAndValidateStartUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds https when protocol is missing and strips hash", async () => {
    // A fresh Response per call: A and AAAA are looked up concurrently and a
    // Response body may only be read once. Upstream shared one Response here
    // and only passed because its DoH errors were swallowed.
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(dnsOk()));

    await expect(
      normalizeAndValidateStartUrl("example.com/path#section"),
    ).resolves.toBe("https://example.com/path");
  });

  it("blocks localhost-like targets", async () => {
    await expect(
      normalizeAndValidateStartUrl("http://localhost:3000"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<UrlPolicyError>);
  });

  it("blocks private ip targets", async () => {
    await expect(
      normalizeAndValidateStartUrl("http://192.168.0.10"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<UrlPolicyError>);
  });

  it("rejects invalid URL input", async () => {
    await expect(
      normalizeAndValidateStartUrl("not a url"),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    } satisfies Partial<UrlPolicyError>);
  });

  it("blocks a public hostname that resolves into private space", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ type: 1, data: "10.0.0.7" }],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      normalizeAndValidateStartUrl("https://internal.example/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<UrlPolicyError>);
  });

  it("refuses mixed public/private DNS answers", async () => {
    vi.mocked(fetch).mockImplementation((input) =>
      Promise.resolve(
        requestUrl(input).endsWith("type=A")
          ? new Response(
              JSON.stringify({
                Status: 0,
                Answer: [
                  { type: 1, data: "93.184.216.34" },
                  { type: 1, data: "127.0.0.1" },
                ],
              }),
              { status: 200 },
            )
          : dnsOk(),
      ),
    );

    await expect(
      normalizeAndValidateStartUrl("https://split.example/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<UrlPolicyError>);
  });

  it("surfaces a DoH failure instead of treating it as allowed", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("dns down"));

    await expect(
      normalizeAndValidateStartUrl("https://example.com/"),
    ).rejects.toMatchObject({
      code: "DNS_RESOLUTION_FAILED",
    } satisfies Partial<UrlPolicyError>);
  });
});

describe("resolveStartUrlRedirects", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Route probe fetches by URL; DoH lookups always resolve clean. */
  function stubFetch(routes: Record<string, () => Response>) {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("dns-query")) return Promise.resolve(dnsOk());
      const route = routes[url];
      return route
        ? Promise.resolve(route())
        : Promise.resolve(new Response(null, { status: 200 }));
    });
  }

  it("follows a cross-domain redirect to the real origin", async () => {
    stubFetch({
      "https://example.net/": () => redirect("https://example.com/"),
    });
    await expect(resolveStartUrlRedirects("https://example.net/")).resolves.toBe(
      "https://example.com/",
    );
  });

  it("follows an apex-to-www redirect chain", async () => {
    stubFetch({
      "https://example.com/": () => redirect("https://www.example.com/"),
    });
    await expect(resolveStartUrlRedirects("https://example.com/")).resolves.toBe(
      "https://www.example.com/",
    );
  });

  it("returns the original URL when the site does not redirect", async () => {
    stubFetch({});
    await expect(resolveStartUrlRedirects("https://example.com/")).resolves.toBe(
      "https://example.com/",
    );
  });

  it("returns the last URL when the probe fails", async () => {
    vi.mocked(fetch).mockImplementation((input) =>
      requestUrl(input).includes("dns-query")
        ? Promise.resolve(dnsOk())
        : Promise.reject(new Error("network down")),
    );
    await expect(resolveStartUrlRedirects("https://example.com/")).resolves.toBe(
      "https://example.com/",
    );
  });

  it("stops after the hop limit on a redirect loop", async () => {
    stubFetch({
      "https://a.example/": () => redirect("https://b.example/"),
      "https://b.example/": () => redirect("https://a.example/"),
    });
    await expect(
      resolveStartUrlRedirects("https://a.example/"),
    ).resolves.toMatch(/^https:\/\/(a|b)\.example\/$/);
  });

  it("rejects redirects into blocked targets", async () => {
    stubFetch({
      "https://example.com/": () => redirect("http://192.168.0.10/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<UrlPolicyError>);
  });
});

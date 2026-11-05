import { describe, expect, it } from "vitest";

import {
  captureResponseHeaders,
  RESPONSE_HEADER_ALLOWLIST,
  RESPONSE_HEADER_VALUE_CAP,
} from "../../src/crawl/response-headers.js";

describe("captureResponseHeaders", () => {
  it("keeps only allowlisted headers, lower-cased", () => {
    const stored = captureResponseHeaders({
      "Strict-Transport-Security": "max-age=31536000",
      "Set-Cookie": "session=secret",
      "X-Custom": "nope",
    });
    expect(stored.values).toEqual({
      "strict-transport-security": ["max-age=31536000"],
    });
    expect(stored.truncated).toEqual([]);
  });

  it("keeps every occurrence of a repeated header in order", () => {
    const stored = captureResponseHeaders({ link: ["<a>; rel=x", "<b>; rel=y"] });
    expect(stored.values["link"]).toEqual(["<a>; rel=x", "<b>; rel=y"]);
  });

  it("cuts at 2,048 and says so", () => {
    expect(RESPONSE_HEADER_VALUE_CAP).toBe(2048);
    const whole = captureResponseHeaders({
      "content-security-policy": "a".repeat(2048),
    });
    expect(whole.values["content-security-policy"]?.[0]).toHaveLength(2048);
    expect(whole.truncated).toEqual([]);

    const cut = captureResponseHeaders({
      "content-security-policy": "a".repeat(2049),
    });
    expect(cut.values["content-security-policy"]?.[0]).toHaveLength(2048);
    expect(cut.truncated).toEqual(["content-security-policy"]);
  });

  it("names a truncated header once however many of its values were cut", () => {
    const cut = captureResponseHeaders({ link: ["a".repeat(3000), "b".repeat(3000)] });
    expect(cut.truncated).toEqual(["link"]);
  });

  it("holds exactly the 20 agreed names, all lower-case", () => {
    expect(RESPONSE_HEADER_ALLOWLIST).toHaveLength(20);
    for (const name of RESPONSE_HEADER_ALLOWLIST) expect(name).toBe(name.toLowerCase());
  });
});

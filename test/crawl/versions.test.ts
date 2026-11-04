import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { engineVersion, redactRequestHeaders } from "../../src/crawl/versions.js";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("redactRequestHeaders", () => {
  it("redacts authorization, cookie and proxy-authorization, case-insensitively, and leaves user-agent alone", () => {
    const out = redactRequestHeaders({
      Authorization: "Bearer secret",
      COOKIE: "a=b",
      "proxy-authorization": "Basic x",
      "user-agent": "AriadneBot-test",
    });
    expect(out).toEqual({
      Authorization: "[redacted]",
      COOKIE: "[redacted]",
      "proxy-authorization": "[redacted]",
      "user-agent": "AriadneBot-test",
    });
  });
});

describe("engineVersion", () => {
  it("names the sha, or says it is unknown", () => {
    expect(engineVersion({ ARIADNE_GIT_SHA: "abc123" })).toBe(`${pkg.version}+abc123`);
    expect(engineVersion({})).toBe(`${pkg.version}+sha-unknown`);
    expect(engineVersion({ ARIADNE_GIT_SHA: "" })).toBe(`${pkg.version}+sha-unknown`);
  });
});

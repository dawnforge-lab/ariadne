import { describe, expect, it } from "vitest";
import {
  parseRefresh,
  REFRESH_RAW_MAX,
  REFRESH_TARGET_MAX,
} from "../../src/crawl/parse/page-facts.js";

const BASE = "https://base.test/dir/page";

describe("parseRefresh", () => {
  it("reads a delay and a relative url", () => {
    const r = parseRefresh("0; url=/next", BASE);
    expect(r.delaySeconds).toBe(0);
    expect(r.target).toBe("https://base.test/next");
  });
  it("a bare delay has no target", () => {
    expect(parseRefresh("5", BASE)).toMatchObject({ delaySeconds: 5, target: null });
  });
  it("reads an upper-case URL= with quotes", () => {
    expect(parseRefresh("3;URL='https://x.test/a'", BASE).target).toBe("https://x.test/a");
  });
  it("a non-numeric value has no delay and no target", () => {
    expect(parseRefresh("abc", BASE)).toMatchObject({ delaySeconds: null, target: null });
  });
  it("an unresolvable url gives a null target", () => {
    expect(parseRefresh("0;url=http://[bad", BASE).target).toBeNull();
  });
  it("requires a separator before the url part", () => {
    expect(parseRefresh("5abc", BASE)).toMatchObject({ delaySeconds: 5, target: null });
    expect(parseRefresh("5 /x", BASE).target).toBe("https://base.test/x");
  });
  it("a url part needs url then = ; a bare url is accepted", () => {
    expect(parseRefresh("0;urlfoo", BASE).target).toBeNull();
    expect(parseRefresh("0;url /x", BASE).target).toBeNull();
    expect(parseRefresh("0; URL = /x", BASE).target).toBe("https://base.test/x");
    expect(parseRefresh("0; /next", BASE).target).toBe("https://base.test/next");
  });
  it("a quoted url ends at the matching quote", () => {
    expect(parseRefresh("0;url='a'b", BASE).target).toBe("https://base.test/dir/a");
    expect(parseRefresh('0;url="a', BASE).target).toBe("https://base.test/dir/a");
  });
  it("an invalid base url throws", () => {
    expect(() => parseRefresh("0;url=/x", "not a url")).toThrow();
  });
  it("caps raw", () => {
    expect(parseRefresh("0;url=/" + "a".repeat(2000), BASE).raw.length).toBe(REFRESH_RAW_MAX);
    expect(REFRESH_RAW_MAX).toBe(512);
  });
  it("caps target at REFRESH_TARGET_MAX (ruling R16)", () => {
    const target = "https://base.test/" + "a".repeat(3_000);
    const r = parseRefresh("0;url=" + target, BASE);
    expect(REFRESH_TARGET_MAX).toBe(1024);
    expect(r.target).toBe(target.slice(0, REFRESH_TARGET_MAX));
    // A target under the cap is untouched.
    expect(parseRefresh("0;url=/short", BASE).target).toBe("https://base.test/short");
  });
});

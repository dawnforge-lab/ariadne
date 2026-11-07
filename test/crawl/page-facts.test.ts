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
  it("a value that is not a refresh has no delay and no target (5abc)", () => {
    expect(parseRefresh("5abc", BASE)).toMatchObject({ delaySeconds: null, target: null });
    expect(parseRefresh("", BASE)).toMatchObject({ delaySeconds: null, target: null });
    expect(parseRefresh(" \t", BASE)).toMatchObject({ delaySeconds: null, target: null });
    expect(parseRefresh("5 /x", BASE).target).toBe("https://base.test/x");
  });
  it("ignores a run of digits and dots after the delay, which is the integer part", () => {
    expect(parseRefresh("1.5.3; url=/x", BASE)).toMatchObject({
      delaySeconds: 1,
      target: "https://base.test/x",
    });
    expect(parseRefresh(".5; url=/x", BASE)).toMatchObject({
      delaySeconds: 0,
      target: "https://base.test/x",
    });
    expect(parseRefresh("2.", BASE)).toMatchObject({ delaySeconds: 2, target: null });
  });
  it("a url part without = is parsed whole, url prefix included (WHATWG)", () => {
    expect(parseRefresh("0; urlredirect.html", BASE).target).toBe(
      "https://base.test/dir/urlredirect.html",
    );
    expect(parseRefresh("0;urlfoo", BASE).target).toBe("https://base.test/dir/urlfoo");
    expect(parseRefresh("0; URL /next", BASE).target).toBe("https://base.test/dir/URL%20/next");
    expect(parseRefresh("0;url /x", BASE).target).toBe("https://base.test/dir/url%20/x");
    expect(parseRefresh("0; URL = /x", BASE).target).toBe("https://base.test/x");
    expect(parseRefresh("0; /next", BASE).target).toBe("https://base.test/next");
    expect(parseRefresh("0;u/x", BASE).target).toBe("https://base.test/dir/u/x");
  });
  it("a quoted url ends at the matching quote", () => {
    expect(parseRefresh("0;url='a'b", BASE).target).toBe("https://base.test/dir/a");
    expect(parseRefresh('0;url="a', BASE).target).toBe("https://base.test/dir/a");
    expect(parseRefresh("0;url='/a'b'", BASE).target).toBe("https://base.test/a");
  });
  it("an empty url part is a reload timer: no target", () => {
    expect(parseRefresh("0;url=", BASE)).toMatchObject({ delaySeconds: 0, target: null });
    expect(parseRefresh("0;url=''", BASE)).toMatchObject({ delaySeconds: 0, target: null });
    expect(parseRefresh("0; ", BASE)).toMatchObject({ delaySeconds: 0, target: null });
  });
  it("skips ASCII whitespace only, never other JS whitespace", () => {
    // U+00A0 is not ASCII whitespace: it is not a separator, so not a refresh.
    expect(parseRefresh("0\u00a0/x", BASE)).toMatchObject({ delaySeconds: null, target: null });
    expect(parseRefresh("\u00a00;url=/x", BASE)).toMatchObject({
      delaySeconds: null,
      target: null,
    });
    expect(parseRefresh("\f0\n;\r\turl\n=\t/x", BASE).target).toBe("https://base.test/x");
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

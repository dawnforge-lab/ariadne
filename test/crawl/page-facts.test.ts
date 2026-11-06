import { describe, expect, it } from "vitest";
import { parseRefresh, REFRESH_RAW_MAX } from "../../src/crawl/parse/page-facts.js";

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
  it("caps raw", () => {
    expect(parseRefresh("0;url=/" + "a".repeat(2000), BASE).raw.length).toBe(REFRESH_RAW_MAX);
    expect(REFRESH_RAW_MAX).toBe(512);
  });
});

import { describe, expect, it } from "vitest";

import { readControlRequest, readPauseReason } from "../../src/crawl/control.js";

describe("control readers", () => {
  it("readControlRequest passes null and the two requests, refuses anything else naming the crawl", () => {
    expect(readControlRequest(null, "crawl_a")).toBeNull();
    expect(readControlRequest("pause", "crawl_a")).toBe("pause");
    expect(readControlRequest("cancel", "crawl_a")).toBe("cancel");
    expect(() => readControlRequest("stop", "crawl_a")).toThrow(/crawl_a.*"stop"/);
    expect(() => readControlRequest(undefined, "crawl_a")).toThrow(/crawl_a/);
  });

  it("readPauseReason passes null and the two reasons, refuses anything else naming the crawl", () => {
    expect(readPauseReason(null, "crawl_b")).toBeNull();
    expect(readPauseReason("request", "crawl_b")).toBe("request");
    expect(readPauseReason("shutdown", "crawl_b")).toBe("shutdown");
    expect(() => readPauseReason("later", "crawl_b")).toThrow(/crawl_b.*"later"/);
  });
});

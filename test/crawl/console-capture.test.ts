import { describe, expect, it } from "vitest";

import {
  RENDER_CONSOLE_MAX_CHARS,
  RENDER_CONSOLE_MAX_ENTRIES,
  RenderConsoleCollector,
} from "../../src/crawl/render/console-capture.js";

const NO_BLOCKS = { thirdParty: 0, sameOriginAssets: 0 };

/** ES2024's `String.prototype.isWellFormed` (Node 22); the project's ES2023 lib does not declare it. */
function isWellFormed(s: string): boolean {
  return (s as string & { isWellFormed(): boolean }).isWellFormed();
}

describe("RenderConsoleCollector", () => {
  it("pins the caps", () => {
    expect(RENDER_CONSOLE_MAX_ENTRIES).toBe(20);
    expect(RENDER_CONSOLE_MAX_CHARS).toBe(500);
  });

  it("keeps 20 per kind and counts all", () => {
    const c = new RenderConsoleCollector();
    for (let i = 0; i < 25; i += 1) c.addConsole(i % 2 === 0 ? "error" : "warning", `message ${i}`);
    for (let i = 0; i < 21; i += 1) c.addException(`boom ${i}`);
    for (let i = 0; i < 22; i += 1) c.addFailedRequest(`http://site.test/${i}.js`, 404, "http 404");

    const s = c.snapshot(NO_BLOCKS);

    expect(s.console).toHaveLength(20);
    expect(s.consoleTotal).toBe(25);
    // The FIRST twenty, in arrival order: the earliest error is usually the cause.
    expect(s.console[0]).toEqual({ level: "error", text: "message 0", cut: false });
    expect(s.console[19]).toEqual({ level: "warning", text: "message 19", cut: false });
    expect(s.exceptions).toHaveLength(20);
    expect(s.exceptionsTotal).toBe(21);
    expect(s.failedRequests).toHaveLength(20);
    expect(s.failedRequestsTotal).toBe(22);
    expect(s.failedRequests[0]).toEqual({
      url: "http://site.test/0.js",
      status: 404,
      reason: "http 404",
      cut: false,
    });
  });

  it("cuts at 500 and marks it", () => {
    const c = new RenderConsoleCollector();
    c.addConsole("error", "x".repeat(500));
    c.addConsole("error", "y".repeat(501));
    c.addException("z".repeat(501));
    c.addFailedRequest(`http://site.test/${"a".repeat(600)}`, null, "net::ERR_CONNECTION_RESET");

    const s = c.snapshot(NO_BLOCKS);

    // Exactly at the cap is whole, and says so.
    expect(s.console[0]).toEqual({ level: "error", text: "x".repeat(500), cut: false });
    expect(s.console[1]!.cut).toBe(true);
    expect(s.console[1]!.text).toHaveLength(500);
    expect(s.exceptions[0]!.cut).toBe(true);
    expect(s.exceptions[0]!.text).toHaveLength(500);
    expect(s.failedRequests[0]!.cut).toBe(true);
    expect(s.failedRequests[0]!.url).toHaveLength(500);
    expect(s.failedRequests[0]!.status).toBeNull();
  });

  it("never leaves half a surrogate pair at the cut", () => {
    const c = new RenderConsoleCollector();
    // 499 ASCII characters, then an emoji (two UTF-16 units) straddling the cap.
    c.addConsole("error", `${"a".repeat(499)}\u{1F600}tail`);

    const text = c.snapshot(NO_BLOCKS).console[0]!.text;

    expect(text).toBe("a".repeat(499));
    expect(isWellFormed(text)).toBe(true);
  });

  it("stores a NUL and a lone surrogate as visible, well-formed text", () => {
    // Postgres jsonb rejects U+0000 and unpaired surrogates: one hostile page
    // must not be able to stop the render pass at the writer.
    const c = new RenderConsoleCollector();
    c.addConsole("warning", "nul:\u0000 lone:\uD800 end");
    c.addException("lone low \uDC00");
    c.addFailedRequest("http://site.test/\u0000", 500, "http 500");

    const s = c.snapshot(NO_BLOCKS);

    expect(s.console[0]!.text).toBe("nul:\\u0000 lone:\uFFFD end");
    expect(s.console[0]!.cut).toBe(false);
    expect(s.exceptions[0]!.text).toBe("lone low \uFFFD");
    expect(s.failedRequests[0]!.url).toBe("http://site.test/\\u0000");
    // …and the whole snapshot survives a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    for (const t of [s.console[0]!.text, s.exceptions[0]!.text, s.failedRequests[0]!.url]) {
      expect(isWellFormed(t)).toBe(true);
      expect(t.includes("\u0000")).toBe(false);
    }
  });

  it("cuts after making the NUL visible, so the stored text never exceeds the cap", () => {
    const c = new RenderConsoleCollector();
    c.addConsole("error", "\u0000".repeat(100));

    const entry = c.snapshot(NO_BLOCKS).console[0]!;

    expect(entry.cut).toBe(true);
    expect(entry.text.length).toBeLessThanOrEqual(500);
  });

  it("reports a clean page as zero counts, not as nothing", () => {
    const s = new RenderConsoleCollector().snapshot({ thirdParty: 2, sameOriginAssets: 1 });

    expect(s).toEqual({
      console: [],
      consoleTotal: 0,
      exceptions: [],
      exceptionsTotal: 0,
      failedRequests: [],
      failedRequestsTotal: 0,
      blockedByRenderer: { thirdParty: 2, sameOriginAssets: 1 },
    });
  });

  it("hands out a snapshot later additions do not change", () => {
    const c = new RenderConsoleCollector();
    c.addConsole("error", "first");
    const s = c.snapshot(NO_BLOCKS);
    c.addConsole("error", "second");

    expect(s.console).toHaveLength(1);
    expect(s.consoleTotal).toBe(1);
  });
});

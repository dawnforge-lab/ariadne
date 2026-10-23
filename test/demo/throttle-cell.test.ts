/**
 * THE "throttled by site" CELL: the one string the demo composes out of
 * `crawl_status.throttle` (Phase 24a). Lifted out of the page and run, the way
 * test/demo/metric-number.test.ts does it — `flow.test.ts` can only read source.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEMO_PAGE, liftFunctions } from "./lift.js";

interface T {
  responses429: number;
  retryAfterSeen: number;
  escalations: number;
  recoveries: number;
  recoveryLocked: boolean;
  peakSpacingMs: number;
  finalSpacingMs: number;
}
const throttleLine = liftFunctions<(host: string, t: T) => string | null>(["throttleLine"], "throttleLine");

const base: T = {
  responses429: 0,
  retryAfterSeen: 0,
  escalations: 0,
  recoveries: 0,
  recoveryLocked: false,
  peakSpacingMs: 1000,
  finalSpacingMs: 1000,
};

describe("the throttled-by-site cell", () => {
  it("renders nothing for a host that never pushed back", () => {
    expect(throttleLine("a.example", base)).toBeNull();
  });

  it("renders when only 429s were seen, or only escalations", () => {
    expect(throttleLine("a.example", { ...base, responses429: 2 })).not.toBeNull();
    expect(throttleLine("a.example", { ...base, escalations: 1 })).not.toBeNull();
  });

  it("says the orchestrator's sentence, with the lock only when locked", () => {
    const t = { ...base, responses429: 14, escalations: 3, recoveries: 1, peakSpacingMs: 8000, finalSpacingMs: 4000 };
    expect(throttleLine("shop.example", t)).toBe(
      "shop.example: 14 × 429, slowed 3×, recovered 1×, spacing 4 s (peak 8 s)",
    );
    expect(throttleLine("shop.example", { ...t, recoveryLocked: true })).toBe(
      "shop.example: 14 × 429, slowed 3×, recovered 1×, recovery locked, spacing 4 s (peak 8 s)",
    );
  });

  it("prints fractional seconds without padding", () => {
    expect(throttleLine("h", { ...base, escalations: 1, peakSpacingMs: 1500, finalSpacingMs: 1500 })).toContain(
      "spacing 1.5 s (peak 1.5 s)",
    );
  });

  it("is wired into the progress grid under the label, one cell per host", () => {
    const html = readFileSync(DEMO_PAGE, "utf8");
    expect(html).toContain('cell(progressGrid, "throttled by site", line)');
    expect(html).toContain("detail.throttle");
  });
});

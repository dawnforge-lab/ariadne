/**
 * scripts/gate-rules.ts times every rule by re-registering it behind a
 * stopwatch (`TimedRegistry.wrap`). The script runs `main()` on import, so the
 * wrapper cannot be imported; this pins its source instead. A wrapper that
 * calls `rule.run` with fewer arguments than `runRules` passes would compile
 * (tsc accepts shorter parameter lists) and silently judge a gate re-run at the
 * defaults, dropping the crawl's JudgementContext and finding cap (27a T3).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(import.meta.dirname, "../../scripts/gate-rules.ts"), "utf8");
const wrap = SRC.slice(SRC.indexOf("wrap(rule: AnyRule)"), SRC.indexOf("function timedRegistry"));

describe("gate-rules TimedRegistry.wrap forwards everything runRules passes", () => {
  it("calls rule.run with each kind's full argument list", () => {
    expect(wrap).toContain("rule.run(page, ctx)");
    expect(wrap).toContain("rule.run(db, crawlId, caps, ctx)");
    expect(wrap).toContain("rule.run(db, crawlId, ctx)");
  });

  it("has no other rule.run call, so no kind forwards fewer arguments", () => {
    expect(wrap.match(/rule\.run\(/g)).toHaveLength(3);
  });
});

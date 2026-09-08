/**
 * The checklist severity drift query.
 *
 * Hard rule 10 says the checklist at `skills/ariadne-audit/checklist.md` is the
 * living authority and that coverage is a CI query rather than a claim in a
 * document. `coverage.test.ts` is that query for CHECK ids; this is it for
 * SEVERITIES. The checklist names a rule's severity inline — ``` `title.missing`
 * (critical) ``` — in ninety-odd places, and every one of them is a promise to
 * the agent reading the check about which band the finding will arrive in. Until
 * this file existed, nothing tied those parentheticals to the registry: the
 * Phase 16 recalibration moved 29 of them by hand, and a hand sweep is exactly
 * the thing that silently rots on the next one.
 *
 * Two assertions, and they fail in both directions. Every id the checklist names
 * must exist in the registry (a typo or a deleted rule is a failure, not a
 * mention that quietly means nothing), and every severity it names must be the
 * severity the registry ships. No tolerance and no skip path: a missing file or
 * a checklist that suddenly names no severities at all fails loudly rather than
 * passing on an empty set, because a regex that stops matching is the one way
 * this test could go green while saying nothing.
 *
 * The mention regex is deliberately whitespace-tolerant. The checklist is prose
 * wrapped at 80 columns, so a mention is as often split across a line break —
 * `` `mobile.viewport-missing` `` at the end of one line and `(critical):` at the
 * start of the next — as it is written on one, and the parenthetical also takes
 * a trailing clause (`(info, the same marker CHECK-13 reads: …)`). A line-wise
 * `grep` for the tight form finds 75 of the 96 mentions and misses 21, which is
 * how five of the recalibration's rules nearly escaped the sweep.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildRegistry } from "../../src/rules/index.js";

const CHECKLIST = new URL("../../skills/ariadne-audit/checklist.md", import.meta.url);

/** ``` `rule.id` (severity ``` — the trailing clause and any line break inside it are the checklist's business, not ours. */
const MENTION = /`([a-z0-9.-]+)`\s+\((critical|warning|info)\b/g;

interface Mention {
  readonly line: number;
  readonly id: string;
  readonly severity: string;
}

function mentions(): Mention[] {
  const src = readFileSync(CHECKLIST, "utf8");
  const found: Mention[] = [];
  for (const m of src.matchAll(MENTION)) {
    found.push({
      line: src.slice(0, m.index).split("\n").length,
      id: m[1]!,
      severity: m[2]!,
    });
  }
  return found;
}

describe("checklist severity parentheticals", () => {
  it("finds mentions at all", () => {
    // The guard on the guard. If the checklist's prose form changes and the
    // regex stops matching, the two assertions below become vacuously true —
    // so the count is asserted as a floor before anything is compared.
    expect(mentions().length).toBeGreaterThanOrEqual(90);
  });

  it("names only rules that exist", () => {
    const ids = new Set(buildRegistry().all().map((r) => r.id));
    const unknown = [...new Set(mentions().filter((m) => !ids.has(m.id)).map((m) => m.id))];
    expect(unknown, `checklist names rule ids the registry does not have: ${unknown.join(", ")}`)
      .toEqual([]);
  });

  it("agrees with the registry on every severity", () => {
    const severities = new Map(buildRegistry().all().map((r) => [r.id, r.severity as string]));
    const drift = mentions()
      .filter((m) => severities.has(m.id) && severities.get(m.id) !== m.severity)
      .map((m) => `checklist.md:${m.line} ${m.id}: checklist says ${m.severity}, registry says ${severities.get(m.id)}`);
    expect(drift, `checklist and registry disagree:\n${drift.join("\n")}`).toEqual([]);
  });
});

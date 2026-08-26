import { describe, expect, it } from "vitest";
import { indexabilityRules } from "../../src/rules/page/indexability.js";
import { expectSilentOnNonOkFetches, mkPage, ruleLookup } from "./mk-page.js";

const rule = ruleLookup(indexabilityRules, "indexabilityRules");

/** A noindex meta alone fires the fact rule; a disagreeing header adds the conflict. */
const BROKEN_DIRECTIVES = [
  { robotsMeta: "noindex", isIndexable: false },
  { robotsMeta: "noindex", xRobotsTag: "index, follow", isIndexable: false },
];

describe("indexabilityRules metadata", () => {
  it("defines exactly the two indexability rules of the Phase 2 table", () => {
    expect(indexabilityRules.map((r) => r.id).sort()).toEqual([
      "indexability.meta-header-conflict",
      "indexability.noindex",
    ]);
  });

  it("claims exactly the checklist ids the table assigns", () => {
    expect(Object.fromEntries(indexabilityRules.map((r) => [r.id, r.checkIds]))).toEqual({
      "indexability.noindex": ["CHECK-04"],
      "indexability.meta-header-conflict": ["CHECK-04"],
    });
  });

  it("carries the severities the table assigns", () => {
    expect(Object.fromEntries(indexabilityRules.map((r) => [r.id, r.severity]))).toEqual({
      "indexability.noindex": "info",
      "indexability.meta-header-conflict": "warning",
    });
  });

  it("every rule is a page rule carrying copy and a ruleset version", () => {
    for (const r of indexabilityRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.category, r.id).toBe("indexability");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });

  it("no rule fires on the clean page, which declares no robots directive", () => {
    for (const r of indexabilityRules) expect(r.run(mkPage()), r.id).toHaveLength(0);
  });

  it("no rule fires on a page that was not fetched as a 200 OK", () => {
    expectSilentOnNonOkFetches(indexabilityRules, BROKEN_DIRECTIVES);
  });
});

describe("indexability.noindex", () => {
  // Edge case from the table: this is a fact, not a fault. A thank-you page is
  // meant to be noindex, so the rule states what it found and severity stays
  // info — the agent decides whether it is a problem.
  it("is a fact rule: severity info", () => {
    expect(rule("indexability.noindex").severity).toBe("info");
    const f = rule("indexability.noindex").run(mkPage({ robotsMeta: "noindex" }));
    expect(f[0]!.severity).toBe("info");
  });

  it("fires on a robots meta noindex and names the source", () => {
    const f = rule("indexability.noindex").run(
      mkPage({ robotsMeta: "noindex, nofollow", isIndexable: false }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.ruleId).toBe("indexability.noindex");
    expect(f[0]!.evidence).toMatchObject({
      robotsMeta: "noindex, nofollow",
      xRobotsTag: null,
      source: "meta",
    });
  });

  it("fires on an X-Robots-Tag noindex and names the source", () => {
    const f = rule("indexability.noindex").run(mkPage({ xRobotsTag: "noindex" }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({
      robotsMeta: null,
      xRobotsTag: "noindex",
      source: "header",
    });
  });

  it("names source 'both' when meta and header agree on noindex", () => {
    const f = rule("indexability.noindex").run(
      mkPage({ robotsMeta: "noindex", xRobotsTag: "noindex, nofollow" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ source: "both" });
  });

  it("matches the directive case-insensitively and inside a directive list", () => {
    for (const robotsMeta of ["NOINDEX", "NoIndex", "max-snippet:-1, noindex", "noindex,follow"]) {
      expect(rule("indexability.noindex").run(mkPage({ robotsMeta })), robotsMeta)
        .toHaveLength(1);
    }
  });

  // `none` is Google's documented shorthand for "noindex, nofollow", so a page
  // carrying it is out of the index exactly as if it had said noindex.
  it("treats the `none` directive as noindex, in either source", () => {
    for (const robotsMeta of ["none", "NONE", "none, noarchive", "max-snippet:-1,none"]) {
      expect(rule("indexability.noindex").run(mkPage({ robotsMeta })), robotsMeta)
        .toHaveLength(1);
    }
    expect(rule("indexability.noindex").run(mkPage({ xRobotsTag: "none" }))).toHaveLength(1);
  });

  // `none` is matched as a whole token, never as a substring: a directive list
  // is comma- and space-delimited, and a word that merely contains "none" is
  // not the directive.
  it("does not read `none` inside a longer word as the directive", () => {
    for (const robotsMeta of ["nonevent", "unnone", "nonesuch, noarchive", "none-such"]) {
      expect(rule("indexability.noindex").run(mkPage({ robotsMeta })), robotsMeta)
        .toHaveLength(0);
    }
  });

  it("is silent on directives that do not say noindex", () => {
    for (const robotsMeta of ["index, follow", "nofollow", "noarchive", "", null]) {
      expect(rule("indexability.noindex").run(mkPage({ robotsMeta })), String(robotsMeta))
        .toHaveLength(0);
    }
  });

  it("fires only once when both sources say noindex", () => {
    expect(
      rule("indexability.noindex").run(mkPage({ robotsMeta: "noindex", xRobotsTag: "noindex" })),
    ).toHaveLength(1);
  });
});

describe("indexability.meta-header-conflict", () => {
  it("fires when the meta says noindex and the header says index", () => {
    const f = rule("indexability.meta-header-conflict").run(
      mkPage({ robotsMeta: "noindex", xRobotsTag: "index, follow" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.evidence).toMatchObject({
      robotsMeta: "noindex",
      xRobotsTag: "index, follow",
    });
  });

  it("fires when the header says noindex and the meta does not", () => {
    const f = rule("indexability.meta-header-conflict").run(
      mkPage({ robotsMeta: "index, follow", xRobotsTag: "noindex" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ robotsMeta: "index, follow", xRobotsTag: "noindex" });
  });

  // Edge case from the table: agreement is not a conflict. Reporting it is
  // indexability.noindex's job, with source "both".
  it("is silent when both say noindex", () => {
    expect(
      rule("indexability.meta-header-conflict").run(
        mkPage({ robotsMeta: "noindex", xRobotsTag: "noindex, nofollow" }),
      ),
    ).toHaveLength(0);
  });

  it("counts a `none` directive as the noindex side of a conflict", () => {
    expect(
      rule("indexability.meta-header-conflict").run(
        mkPage({ robotsMeta: "none", xRobotsTag: "index, follow" }),
      ),
    ).toHaveLength(1);
    expect(
      rule("indexability.meta-header-conflict").run(
        mkPage({ robotsMeta: "none", xRobotsTag: "noindex" }),
      ),
    ).toHaveLength(0);
  });

  it("is silent when both say index", () => {
    expect(
      rule("indexability.meta-header-conflict").run(
        mkPage({ robotsMeta: "index", xRobotsTag: "index" }),
      ),
    ).toHaveLength(0);
  });

  it("needs both declarations present: one noindex source alone is no conflict", () => {
    for (const page of [
      { robotsMeta: "noindex", xRobotsTag: null },
      { robotsMeta: null, xRobotsTag: "noindex" },
      { robotsMeta: "noindex", xRobotsTag: "" },
      { robotsMeta: "noindex", xRobotsTag: "   " },
      { robotsMeta: null, xRobotsTag: null },
    ]) {
      expect(
        rule("indexability.meta-header-conflict").run(mkPage(page)),
        JSON.stringify(page),
      ).toHaveLength(0);
    }
  });

  it("is silent when neither source says noindex, however they differ", () => {
    expect(
      rule("indexability.meta-header-conflict").run(
        mkPage({ robotsMeta: "nofollow", xRobotsTag: "noarchive" }),
      ),
    ).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { anchorRules } from "../../src/rules/page/anchors.js";
import { expectSilentOnNonOkFetches, mkPage, mkV1Page, ruleLookup } from "./mk-page.js";

const rule = ruleLookup(anchorRules, "anchorRules");
const COUNTS = { noHref: 0, javascript: 0, hashOnly: 0, emptyHref: 0, unsafeBlank: 0 };
const withCounts = (c: Partial<typeof COUNTS>) =>
  mkPage({ anchorCounts: { ...COUNTS, ...c } });

describe("anchorRules metadata", () => {
  it("defines the three anchor rules with the brief's checks and severities", () => {
    expect(
      Object.fromEntries(anchorRules.map((r) => [r.id, [r.checkIds, r.severity, r.category]])),
    ).toEqual({
      "links.uncrawlable": [["CHECK-34"], "warning", "links"],
      "links.empty-href": [["CHECK-86"], "info", "links"],
      "links.unsafe-target-blank": [["CHECK-86"], "info", "links"],
    });
  });
});

describe("links.uncrawlable", () => {
  const r = rule("links.uncrawlable");

  it("fires on each of no-href, javascript: and # alone, with all three counts as evidence", () => {
    for (const c of [{ noHref: 1 }, { javascript: 2 }, { hashOnly: 3 }]) {
      const out = r.run(withCounts(c));
      expect(out, JSON.stringify(c)).toHaveLength(1);
      expect(out[0]!.evidence).toEqual({ noHref: 0, javascript: 0, hashOnly: 0, ...c });
    }
  });

  it("is silent on a clean page and on empty href / unsafe blank counts alone", () => {
    expect(r.run(mkPage())).toEqual([]);
    expect(r.run(withCounts({ emptyHref: 4, unsafeBlank: 4 }))).toEqual([]);
  });

  it("is silent on a v1 row (null anchorCounts)", () => {
    expect(r.run(mkV1Page())).toEqual([]);
  });

  it("is silent on a page that is not fetched OK", () => {
    expectSilentOnNonOkFetches([r], [{ anchorCounts: { ...COUNTS, noHref: 1 } }]);
  });
});

describe("links.empty-href", () => {
  const r = rule("links.empty-href");

  it("fires on emptyHref > 0 and carries the count", () => {
    const out = r.run(withCounts({ emptyHref: 2 }));
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual({ emptyHref: 2 });
  });

  it("is silent on zero, on the other counts, and on a v1 row", () => {
    expect(r.run(mkPage())).toEqual([]);
    expect(r.run(withCounts({ noHref: 1, javascript: 1, hashOnly: 1, unsafeBlank: 1 }))).toEqual([]);
    expect(r.run(mkV1Page())).toEqual([]);
  });

  it("is silent on a page that is not fetched OK", () => {
    expectSilentOnNonOkFetches([r], [{ anchorCounts: { ...COUNTS, emptyHref: 1 } }]);
  });
});

describe("links.unsafe-target-blank", () => {
  const r = rule("links.unsafe-target-blank");

  it("fires on unsafeBlank > 0 and carries the count", () => {
    const out = r.run(withCounts({ unsafeBlank: 5 }));
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual({ unsafeBlank: 5 });
  });

  it("is silent on zero, on the other counts, and on a v1 row", () => {
    expect(r.run(mkPage())).toEqual([]);
    expect(r.run(withCounts({ noHref: 1, javascript: 1, hashOnly: 1, emptyHref: 1 }))).toEqual([]);
    expect(r.run(mkV1Page())).toEqual([]);
  });

  it("is silent on a page that is not fetched OK", () => {
    expectSilentOnNonOkFetches([r], [{ anchorCounts: { ...COUNTS, unsafeBlank: 1 } }]);
  });
});

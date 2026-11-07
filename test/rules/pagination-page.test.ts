import { describe, expect, it } from "vitest";
import { paginationPageRules } from "../../src/rules/page/pagination.js";
import { expectSilentOnNonOkFetches, mkPage, mkV1Page, ruleLookup } from "./mk-page.js";

const rule = ruleLookup(paginationPageRules, "paginationPageRules");
const r = rule("pagination.multiple");

describe("pagination.multiple", () => {
  it("claims CHECK-22 as an info rule in the url category", () => {
    expect([r.checkIds, r.severity, r.category]).toEqual([["CHECK-22"], "info", "url"]);
  });

  it("fires on two rel=next, or two rel=prev, carrying both counts", () => {
    expect(r.run(mkPage({ relNextCount: 2, relPrevCount: 0 }))[0]!.evidence).toEqual({
      relNextCount: 2,
      relPrevCount: 0,
    });
    expect(r.run(mkPage({ relNextCount: 1, relPrevCount: 3 }))[0]!.evidence).toEqual({
      relNextCount: 1,
      relPrevCount: 3,
    });
  });

  it("is silent on one of each, none, and the clean page", () => {
    expect(r.run(mkPage({ relNextCount: 1, relPrevCount: 1 }))).toEqual([]);
    expect(r.run(mkPage({ relNextCount: 0, relPrevCount: 0 }))).toEqual([]);
    expect(r.run(mkPage())).toEqual([]);
  });

  it("is silent on a v1 row (null counts)", () => {
    expect(r.run(mkV1Page())).toEqual([]);
    expect(r.run(mkV1Page({ relNext: "https://example.com/p2" }))).toEqual([]);
  });

  it("is silent on a page that is not fetched OK", () => {
    expectSilentOnNonOkFetches([r], [{ relNextCount: 2, relPrevCount: 0 }]);
  });
});

/**
 * `redirect.meta-refresh` (Phase 26b, Task 8): a meta refresh or `Refresh`
 * header that names a URL.
 */
import { describe, expect, it } from "vitest";
import { refreshRules } from "../../src/rules/page/refresh.js";
import { expectSilentOnNonOkFetches, mkPage, mkV1Page, ruleLookup } from "./mk-page.js";

const r = ruleLookup(refreshRules, "refreshRules")("redirect.meta-refresh");
const PAGE_URL = "https://example.test/page";
const withHeader = (value: string) => ({
  values: { refresh: [value] },
  truncated: [],
});

describe("redirect.meta-refresh", () => {
  it("is a warning page rule in the redirects category on CHECK-10", () => {
    expect([r.kind, r.severity, r.category, r.checkIds]).toEqual([
      "page",
      "warning",
      "redirects",
      ["CHECK-10"],
    ]);
  });

  it("fires on a meta refresh with a target", () => {
    const out = r.run(
      mkPage({
        url: PAGE_URL,
        metaRefresh: { raw: "5; url=/next", delaySeconds: 5, target: "https://example.test/next" },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual({
      source: "meta",
      target: "https://example.test/next",
      delaySeconds: 5,
      selfTarget: false,
    });
  });

  it("flags a refresh to the page itself", () => {
    const out = r.run(
      mkPage({
        url: PAGE_URL,
        metaRefresh: { raw: "0;url=" + PAGE_URL, delaySeconds: 0, target: PAGE_URL },
      }),
    );
    expect(out[0]!.evidence).toMatchObject({ selfTarget: true, delaySeconds: 0 });
  });

  it("is silent on a refresh with no URL", () => {
    expect(
      r.run(mkPage({ metaRefresh: { raw: "30", delaySeconds: 30, target: null } })),
    ).toHaveLength(0);
  });

  it("fires on a header-only refresh, resolved against the page URL", () => {
    const out = r.run(mkPage({ url: PAGE_URL, responseHeaders: withHeader("0; url=/moved") }));
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toEqual({
      source: "header",
      target: "https://example.test/moved",
      delaySeconds: 0,
      selfTarget: false,
    });
  });

  it("says both when the meta and the header both name a target", () => {
    const out = r.run(
      mkPage({
        url: PAGE_URL,
        metaRefresh: { raw: "0;url=/a", delaySeconds: 0, target: "https://example.test/a" },
        responseHeaders: withHeader("0;url=/b"),
      }),
    );
    expect(out[0]!.evidence).toMatchObject({ source: "both", target: "https://example.test/a" });
  });

  it("is silent on a header with no URL, and on a v1 row", () => {
    expect(r.run(mkPage({ url: PAGE_URL, responseHeaders: withHeader("10") }))).toHaveLength(0);
    expect(r.run(mkV1Page({ url: PAGE_URL }))).toHaveLength(0);
  });

  it("is silent on every non-OK fetch", () => {
    expectSilentOnNonOkFetches(refreshRules, [
      { metaRefresh: { raw: "0;url=/n", delaySeconds: 0, target: "https://example.test/n" } },
    ]);
  });
});

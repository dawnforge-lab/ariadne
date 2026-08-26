import { describe, expect, it } from "vitest";
import { statusRules } from "../../src/rules/page/status.js";
import { mkPage, ruleLookup } from "./mk-page.js";

// No non-200 sweep here on purpose: the status rules are the ones that must
// speak on a broken fetch, so `expectSilentOnNonOkFetches` is not theirs.
const rule = ruleLookup(statusRules, "statusRules");

describe("statusRules metadata", () => {
  it("defines exactly the two status rules of the Phase 2 table", () => {
    expect(statusRules.map((r) => r.id).sort()).toEqual([
      "crawl.blocked",
      "http.server-error",
    ]);
  });

  it("claims the checklist ids the table assigns", () => {
    expect(rule("http.server-error").checkIds).toEqual(["CHECK-12"]);
    expect(rule("crawl.blocked").checkIds).toEqual(["CHECK-05"]);
    for (const r of statusRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.category, r.id).toBe("status");
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });

  it("no status rule fires on a healthy page", () => {
    for (const r of statusRules) expect(r.run(mkPage()), r.id).toHaveLength(0);
  });
});

describe("http.server-error", () => {
  it("fires on a server_error fetch and reports the status code", () => {
    const f = rule("http.server-error").run(
      mkPage({ fetchClass: "server_error", statusCode: 503, title: null }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.ruleId).toBe("http.server-error");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.evidence).toMatchObject({ statusCode: 503 });
    expect(f[0]!.dedupeKey).toBe("https://example.com/page");
  });

  it("fires even when no status code was recorded", () => {
    const f = rule("http.server-error").run(
      mkPage({ fetchClass: "server_error", statusCode: null }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ statusCode: null });
  });

  it("is silent on other fetch classes", () => {
    for (const fetchClass of ["ok", "redirect", "client_error", "blocked", "timeout"]) {
      expect(
        rule("http.server-error").run(mkPage({ fetchClass, statusCode: 500 })),
        fetchClass,
      ).toHaveLength(0);
    }
  });
});

describe("crawl.blocked", () => {
  it("fires on a blocked fetch and reports the status code", () => {
    const f = rule("crawl.blocked").run(
      mkPage({ fetchClass: "blocked", statusCode: 403 }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.ruleId).toBe("crawl.blocked");
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.evidence).toMatchObject({ statusCode: 403 });
  });

  it("is silent on other fetch classes, including 5xx", () => {
    for (const fetchClass of ["ok", "redirect", "client_error", "server_error"]) {
      expect(rule("crawl.blocked").run(mkPage({ fetchClass })), fetchClass).toHaveLength(0);
    }
  });
});

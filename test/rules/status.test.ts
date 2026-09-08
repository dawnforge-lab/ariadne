import { describe, expect, it } from "vitest";
import { FETCH_CLASSES } from "../../src/crawl/fetch-page.js";
import { statusRules } from "../../src/rules/page/status.js";
import { mkPage, ruleLookup } from "./mk-page.js";

/**
 * The two observations, as a rule test states them: the first is `fetchedAt`
 * (mkPage's default), the second is `recheckAt`, and the pair is what
 * `gapSeconds` is computed from. 94 seconds apart, so the number in an
 * assertion is recognisably not a rounding of zero.
 */
const FETCHED_AT = mkPage().fetchedAt!;
const RECHECK_AT = new Date(FETCHED_AT.getTime() + 94_000);

/** A 5xx page whose recheck settled on `recheckFetchClass`, 94 s later. */
function rechecked(recheckFetchClass: string, recheckStatusCode: number | null) {
  return mkPage({
    fetchClass: "server_error",
    statusCode: 503,
    recheckFetchClass,
    recheckStatusCode,
    recheckAt: RECHECK_AT,
  });
}

// No non-200 sweep here on purpose: the status rules are the ones that must
// speak on a broken fetch, so `expectSilentOnNonOkFetches` is not theirs.
const rule = ruleLookup(statusRules, "statusRules");

describe("statusRules metadata", () => {
  it("defines exactly the three status rules", () => {
    expect(statusRules.map((r) => r.id).sort()).toEqual([
      "crawl.blocked",
      "http.server-error",
      "http.server-error-transient",
    ]);
  });

  it("claims the checklist ids the table assigns", () => {
    expect(rule("http.server-error").checkIds).toEqual(["CHECK-12"]);
    expect(rule("http.server-error-transient").checkIds).toEqual(["CHECK-12"]);
    expect(rule("crawl.blocked").checkIds).toEqual(["CHECK-05"]);
    for (const r of statusRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.category, r.id).toBe("crawl");
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

  // The four states of the `recheck` word, each asserted on the column shape
  // that produces it. This is the half of the split that keeps a 5xx critical:
  // "we never asked", "a budget stopped us", "still broken" and "we asked and
  // learned nothing" are four different sentences and one severity.
  it('says "not run" when no pass ever reached the row', () => {
    // Both nulls: NOBODY ASKED (the null contract, src/db/schema.ts). A crawl
    // written before migration 0016 is exactly this shape, which is why an old
    // crawl re-judged at 0.13.0 keeps every Error it had.
    const f = rule("http.server-error").run(
      mkPage({ fetchClass: "server_error", statusCode: 503 }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toEqual({
      statusCode: 503,
      recheck: "not run",
      recheckStatusCode: null,
      recheckFetchClass: null,
      recheckReason: null,
      gapSeconds: null,
    });
  });

  it('says "capped" when the pass decided not to ask and said why', () => {
    // Keyed on the reason being NON-NULL, never on its text: `recheck-cap` is
    // the only reason at launch and a second one must land here unchanged.
    const f = rule("http.server-error").run(
      mkPage({ fetchClass: "server_error", statusCode: 500, recheckReason: "recheck-cap" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({
      recheck: "capped",
      recheckReason: "recheck-cap",
      recheckFetchClass: null,
      gapSeconds: null,
    });
  });

  it('says "confirmed" when the second look got another 5xx', () => {
    const f = rule("http.server-error").run(rechecked("server_error", 500));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.evidence).toEqual({
      statusCode: 503,
      recheck: "confirmed",
      recheckStatusCode: 500,
      recheckFetchClass: "server_error",
      recheckReason: null,
      gapSeconds: 94,
    });
  });

  it('says "inconclusive" on every non-cleared class that is not a 5xx', () => {
    // No answer ABOUT THE PAGE: two that never completed, one about our crawler,
    // one where no request went out at all.
    for (const cls of ["timeout", "network_error", "blocked", "disallowed"]) {
      const f = rule("http.server-error").run(
        mkPage({
          fetchClass: "server_error",
          statusCode: 503,
          recheckFetchClass: cls,
          recheckStatusCode: cls === "blocked" ? 403 : null,
          recheckReason: "the fetch layer's own sentence",
          recheckAt: RECHECK_AT,
        }),
      );
      expect(f, cls).toHaveLength(1);
      expect(f[0]!.evidence, cls).toMatchObject({
        recheck: "inconclusive",
        recheckFetchClass: cls,
        recheckReason: "the fetch layer's own sentence",
        gapSeconds: 94,
      });
    }
  });

  it("reports no gap when the row predates the first timestamp", () => {
    // `fetched_at` null is a row written before migration 0016. A gap needs two
    // timestamps, so the honest answer is null rather than a computed number.
    const f = rule("http.server-error").run(
      mkPage({ ...rechecked("server_error", 500), fetchedAt: null }),
    );
    expect(f[0]!.evidence).toMatchObject({ recheck: "confirmed", gapSeconds: null });
  });
});

describe("http.server-error-transient", () => {
  it("is a warning, claims CHECK-12, and is not a marker", () => {
    const r = rule("http.server-error-transient");
    expect(r.severity).toBe("warning");
    expect(r.checkIds).toEqual(["CHECK-12"]);
    // It reports a fact about the SITE that two observations settled, not a hole
    // in our evidence, so it carries no marker flag and never joins CHECK-83's
    // NOT MEASURED family.
    expect(r.marker).toBeUndefined();
  });

  it("fires on every class that means the site answered, and not with a 5xx", () => {
    for (const cls of [
      "ok",
      "redirect",
      "client_error",
      "non_html",
      "too_large",
      "unsupported_encoding",
    ]) {
      const f = rule("http.server-error-transient").run(rechecked(cls, 200));
      expect(f, cls).toHaveLength(1);
      expect(f[0]!.ruleId, cls).toBe("http.server-error-transient");
      expect(f[0]!.severity, cls).toBe("warning");
      expect(f[0]!.evidence, cls).toEqual({
        statusCode: 503,
        recheckStatusCode: 200,
        recheckFetchClass: cls,
        gapSeconds: 94,
      });
    }
  });

  it("reports no gap when the row predates the first timestamp", () => {
    const f = rule("http.server-error-transient").run(
      mkPage({ ...rechecked("ok", 200), fetchedAt: null }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ recheckFetchClass: "ok", gapSeconds: null });
  });

  it("is silent on a first observation that was not a 5xx", () => {
    // A recheck class on a row whose FIRST fetch was fine is not this rule's
    // subject — nothing was ever broken to clear.
    for (const fetchClass of ["ok", "redirect", "client_error", "blocked", "timeout"]) {
      expect(
        rule("http.server-error-transient").run(
          mkPage({ fetchClass, statusCode: 200, recheckFetchClass: "ok", recheckAt: RECHECK_AT }),
        ),
        fetchClass,
      ).toHaveLength(0);
    }
  });
});

/**
 * THE HARD-RULE-1 GUARD FOR THE PAIR.
 *
 * The two 5xx rules are defined against one predicate and its negation, so they
 * must be mutually exclusive and jointly exhaustive over every row whose first
 * fetch was a server error. Asserted by looping over the WHOLE `FETCH_CLASSES`
 * union plus null rather than over a hand-listed sample: a class added to
 * `src/crawl/fetch-page.ts` and forgotten in `RECHECK_CLEARED` lands in the
 * `http.server-error` half by construction and this test says so out loud —
 * a new class is a decision, not a default.
 */
describe("the 5xx pair partitions every recheck outcome", () => {
  const CLEARED = new Set([
    "ok",
    "redirect",
    "client_error",
    "non_html",
    "too_large",
    "unsupported_encoding",
  ]);

  it("produces exactly one finding for every recheck class, and for null", () => {
    const classes: (string | null)[] = [...FETCH_CLASSES, null];
    // The sweep would be vacuous if the union ever shrank to nothing.
    expect(classes.length).toBeGreaterThan(10);

    for (const cls of classes) {
      const page = mkPage({
        fetchClass: "server_error",
        statusCode: 503,
        recheckFetchClass: cls,
        recheckStatusCode: cls === null ? null : 200,
        recheckAt: cls === null ? null : RECHECK_AT,
      });
      const fired = statusRules.flatMap((r) => r.run(page).map((f) => f.ruleId));
      expect(fired, `${cls ?? "null"}: exactly one 5xx finding`).toHaveLength(1);
      expect(fired[0], `${cls ?? "null"}`).toBe(
        cls !== null && CLEARED.has(cls)
          ? "http.server-error-transient"
          : "http.server-error",
      );
    }
  });

  it("both are silent on every first observation that is not a 5xx", () => {
    for (const fetchClass of FETCH_CLASSES) {
      if (fetchClass === "server_error") continue;
      for (const cls of [null, "ok", "server_error"]) {
        const page = mkPage({
          fetchClass,
          recheckFetchClass: cls,
          recheckAt: cls === null ? null : RECHECK_AT,
        });
        const fired = statusRules
          .filter((r) => r.id.startsWith("http.server-error"))
          .flatMap((r) => r.run(page).map((f) => f.ruleId));
        expect(fired, `${fetchClass}/${cls ?? "null"}`).toEqual([]);
      }
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
    expect(f[0]!.severity).toBe(rule("crawl.blocked").severity);
    expect(f[0]!.evidence).toMatchObject({ statusCode: 403 });
  });

  it("is a NOT MEASURED marker at info — a crawl refusal is not a site issue", () => {
    // Owner-ruled 2026-09-08 (ruleset 0.12.0). The marker flag is what puts it
    // in CHECK-83's family and keeps it out of the Errors band; `info` is what
    // the marker contract requires (see registry.test.ts "severity shape").
    const r = rule("crawl.blocked");
    expect(r.severity).toBe("info");
    expect(r.marker).toMatch(/refused/);
  });

  it("is silent on other fetch classes, including 5xx", () => {
    for (const fetchClass of ["ok", "redirect", "client_error", "server_error"]) {
      expect(rule("crawl.blocked").run(mkPage({ fetchClass })), fetchClass).toHaveLength(0);
    }
  });
});

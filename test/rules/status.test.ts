import { describe, expect, it } from "vitest";
import { FETCH_CLASSES, MAX_BODY } from "../../src/crawl/fetch-page.js";
import { NO_RESPONSE_ANSWERED, RECHECK_CLEARED, statusRules } from "../../src/rules/page/status.js";
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
  it("defines exactly the seven status rules", () => {
    expect(statusRules.map((r) => r.id).sort()).toEqual([
      "crawl.blocked",
      "crawl.unreadable-encoding",
      "http.no-response",
      "http.no-response-transient",
      "http.server-error",
      "http.server-error-transient",
      "page.html-too-large",
    ]);
  });

  it("claims the checklist ids the table assigns", () => {
    expect(rule("http.server-error").checkIds).toEqual(["CHECK-12"]);
    expect(rule("http.server-error-transient").checkIds).toEqual(["CHECK-12"]);
    expect(rule("http.no-response").checkIds).toEqual(["CHECK-12"]);
    expect(rule("http.no-response-transient").checkIds).toEqual(["CHECK-12"]);
    expect(rule("page.html-too-large").checkIds).toEqual(["CHECK-12"]);
    expect(rule("crawl.blocked").checkIds).toEqual(["CHECK-05"]);
    expect(rule("crawl.unreadable-encoding").checkIds).toEqual(["CHECK-05"]);
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
    // The reason names the cause AND what would answer the check (Phase 19 §6),
    // in one sentence a client reads under "Why:" on the demo row.
    expect(r.marker).toMatch(/bot challenge or access denial/);
    expect(r.marker).toMatch(/crawl again/);
  });

  it("is silent on other fetch classes, including 5xx", () => {
    for (const fetchClass of ["ok", "redirect", "client_error", "server_error"]) {
      expect(rule("crawl.blocked").run(mkPage({ fetchClass })), fetchClass).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 23 (study D2): the fetch outcomes that used to produce no finding.
// ---------------------------------------------------------------------------

/** A no-response page (timeout / network_error) whose recheck settled on `cls`. */
function noResponse(
  fetchClass: "timeout" | "network_error",
  recheckFetchClass: string | null,
  recheckStatusCode: number | null,
) {
  return mkPage({
    fetchClass,
    statusCode: null,
    recheckFetchClass,
    recheckStatusCode,
    recheckAt: recheckFetchClass === null ? null : RECHECK_AT,
  });
}

describe("http.no-response", () => {
  it("is critical, claims CHECK-12, reports under crawl, and is not a marker", () => {
    const r = rule("http.no-response");
    expect(r.severity).toBe("critical");
    expect(r.category).toBe("crawl");
    expect(r.marker).toBeUndefined();
    expect(r.columns?.map((c) => [c.key, c.label])).toEqual([
      ["recheck", "Recheck"],
      ["recheckStatusCode", "Recheck Status Code"],
      ["recheckFetchClass", "Recheck Fetch Class"],
      ["recheckReason", "Recheck Reason"],
      ["gapSeconds", "Recheck Gap (s)"],
    ]);
  });

  it('fires on a timeout and on a network error nobody rechecked, saying "not run"', () => {
    for (const fc of ["timeout", "network_error"] as const) {
      const f = rule("http.no-response").run(noResponse(fc, null, null));
      expect(f, fc).toHaveLength(1);
      expect(f[0]!.evidence, fc).toEqual({
        statusCode: null,
        recheck: "not run",
        recheckStatusCode: null,
        recheckFetchClass: null,
        recheckReason: null,
        gapSeconds: null,
      });
    }
  });

  it('says "capped" when the shared budget stopped the pass short of the row', () => {
    const f = rule("http.no-response").run(
      mkPage({ fetchClass: "timeout", statusCode: null, recheckReason: "recheck-cap" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ recheck: "capped", recheckReason: "recheck-cap" });
  });

  it('says "confirmed" when the second request got no response either', () => {
    for (const fc of ["timeout", "network_error"] as const) {
      for (const again of ["timeout", "network_error"]) {
        const f = rule("http.no-response").run(noResponse(fc, again, null));
        expect(f, `${fc}/${again}`).toHaveLength(1);
        expect(f[0]!.evidence, `${fc}/${again}`).toMatchObject({
          recheck: "confirmed",
          recheckFetchClass: again,
          gapSeconds: 94,
        });
      }
    }
  });

  it('says "inconclusive" when no second request was made (disallowed)', () => {
    const f = rule("http.no-response").run(
      mkPage({
        fetchClass: "network_error",
        statusCode: null,
        recheckFetchClass: "disallowed",
        recheckReason: "robots.txt disallows this URL",
        recheckAt: RECHECK_AT,
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({
      recheck: "inconclusive",
      recheckFetchClass: "disallowed",
      recheckReason: "robots.txt disallows this URL",
    });
  });

  it("is silent on every other first observation", () => {
    for (const fetchClass of FETCH_CLASSES) {
      if (fetchClass === "timeout" || fetchClass === "network_error") continue;
      expect(
        rule("http.no-response").run(mkPage({ fetchClass, statusCode: null })),
        fetchClass,
      ).toHaveLength(0);
    }
  });
});

describe("http.no-response-transient", () => {
  it("is a warning, claims CHECK-12, and is not a marker", () => {
    const r = rule("http.no-response-transient");
    expect(r.severity).toBe("warning");
    expect(r.category).toBe("crawl");
    expect(r.marker).toBeUndefined();
    expect(r.columns?.map((c) => [c.key, c.label])).toEqual([
      ["recheckStatusCode", "Recheck Status Code"],
      ["recheckFetchClass", "Recheck Fetch Class"],
      ["gapSeconds", "Recheck Gap (s)"],
    ]);
  });

  it("fires on every recheck that got an HTTP answer — a 5xx and a block included", () => {
    for (const cls of [...RECHECK_CLEARED, "server_error", "blocked"]) {
      const f = rule("http.no-response-transient").run(noResponse("timeout", cls, 503));
      expect(f, cls).toHaveLength(1);
      expect(f[0]!.severity, cls).toBe("warning");
      expect(f[0]!.evidence, cls).toEqual({
        statusCode: null,
        recheckStatusCode: 503,
        recheckFetchClass: cls,
        gapSeconds: 94,
      });
    }
  });

  it("answers on RECHECK_CLEARED plus server_error and blocked, nothing else", () => {
    expect([...NO_RESPONSE_ANSWERED].sort()).toEqual(
      [...RECHECK_CLEARED, "server_error", "blocked"].sort(),
    );
  });
});

/**
 * THE HARD-RULE-1 GUARD FOR THE NO-RESPONSE PAIR, on the 5xx pair's model:
 * over the WHOLE `FETCH_CLASSES` union plus null, every timeout and every
 * network error carries exactly one of the two findings. The expected set is
 * spelled out here rather than imported, so a class that drifts into or out of
 * `NO_RESPONSE_ANSWERED` is a visible decision.
 */
describe("the no-response pair partitions every recheck outcome", () => {
  const ANSWERED = new Set([
    "ok",
    "redirect",
    "client_error",
    "non_html",
    "too_large",
    "unsupported_encoding",
    "server_error",
    "blocked",
  ]);

  it("produces exactly one finding for every recheck class, and for null", () => {
    const classes: (string | null)[] = [...FETCH_CLASSES, null];
    expect(classes.length).toBeGreaterThan(10);
    for (const fc of ["timeout", "network_error"] as const) {
      for (const cls of classes) {
        const page = noResponse(fc, cls, cls === null ? null : 200);
        const fired = statusRules.flatMap((r) => r.run(page).map((f) => f.ruleId));
        expect(fired, `${fc}/${cls ?? "null"}: exactly one finding`).toHaveLength(1);
        expect(fired[0], `${fc}/${cls ?? "null"}`).toBe(
          cls !== null && ANSWERED.has(cls) ? "http.no-response-transient" : "http.no-response",
        );
      }
    }
  });

  it("both are silent on every first observation that is not a timeout or network error", () => {
    for (const fetchClass of FETCH_CLASSES) {
      if (fetchClass === "timeout" || fetchClass === "network_error") continue;
      for (const cls of [null, "ok", "timeout"]) {
        const page = mkPage({
          fetchClass,
          recheckFetchClass: cls,
          recheckAt: cls === null ? null : RECHECK_AT,
        });
        const fired = statusRules
          .filter((r) => r.id.startsWith("http.no-response"))
          .flatMap((r) => r.run(page).map((f) => f.ruleId));
        expect(fired, `${fetchClass}/${cls ?? "null"}`).toEqual([]);
      }
    }
  });
});

describe("page.html-too-large", () => {
  it("is critical, claims CHECK-12, reports under crawl, and is not a marker", () => {
    const r = rule("page.html-too-large");
    expect(r.severity).toBe("critical");
    expect(r.category).toBe("crawl");
    expect(r.marker).toBeUndefined();
    expect(r.columns?.map((c) => [c.key, c.label])).toEqual([
      ["htmlBytes", "Size (bytes)"],
      ["limit", "Limit (bytes)"],
    ]);
  });

  it("fires on a 200 too_large row with the bytes read and the cap", () => {
    const f = rule("page.html-too-large").run(
      mkPage({ fetchClass: "too_large", statusCode: 200, htmlBytes: MAX_BODY }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toEqual({ statusCode: 200, htmlBytes: MAX_BODY, limit: 2_097_152 });
  });

  it("is silent on a too_large row that is not a 200, and on every other class", () => {
    expect(
      rule("page.html-too-large").run(mkPage({ fetchClass: "too_large", statusCode: 206 })),
    ).toHaveLength(0);
    for (const fetchClass of FETCH_CLASSES) {
      if (fetchClass === "too_large") continue;
      expect(
        rule("page.html-too-large").run(mkPage({ fetchClass, statusCode: 200 })),
        fetchClass,
      ).toHaveLength(0);
    }
  });
});

describe("crawl.unreadable-encoding", () => {
  it("is a NOT MEASURED marker at info under CHECK-05", () => {
    const r = rule("crawl.unreadable-encoding");
    expect(r.severity).toBe("info");
    expect(r.category).toBe("crawl");
    expect(r.marker).toMatch(/compression format/);
    expect(r.columns?.map((c) => [c.key, c.label])).toEqual([["fetchReason", "Encoding"]]);
  });

  it("fires on an unsupported_encoding row and carries the fetch layer's reason", () => {
    const f = rule("crawl.unreadable-encoding").run(
      mkPage({
        fetchClass: "unsupported_encoding",
        statusCode: 200,
        fetchReason: "unsupported content-encoding (br)",
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toEqual({
      statusCode: 200,
      fetchReason: "unsupported content-encoding (br)",
    });
  });

  it("is silent on every other class", () => {
    for (const fetchClass of FETCH_CLASSES) {
      if (fetchClass === "unsupported_encoding") continue;
      expect(
        rule("crawl.unreadable-encoding").run(mkPage({ fetchClass })),
        fetchClass,
      ).toHaveLength(0);
    }
  });
});

/**
 * Every fetch class has an owner. After Phase 23 the first observations that
 * produce no status-rule finding are exactly the ones another family speaks
 * for: ok, redirect (the redirect rules), client_error (the broken-link
 * rules), non_html, and disallowed (robots).
 */
describe("every failed fetch outcome speaks", () => {
  it("fires a status rule on server_error, timeout, network_error, too_large, unsupported_encoding and blocked", () => {
    const speaking: string[] = [];
    for (const fetchClass of FETCH_CLASSES) {
      const page = mkPage({ fetchClass, statusCode: fetchClass === "too_large" ? 200 : null });
      if (statusRules.some((r) => r.run(page).length > 0)) speaking.push(fetchClass);
    }
    expect(speaking.sort()).toEqual(
      ["blocked", "network_error", "server_error", "timeout", "too_large", "unsupported_encoding"].sort(),
    );
  });
});

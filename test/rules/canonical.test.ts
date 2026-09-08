import { describe, expect, it } from "vitest";
import { canonicalRules } from "../../src/rules/page/canonical.js";
import { expectSilentOnNonOkFetches, mkPage, ruleLookup } from "./mk-page.js";

const rule = ruleLookup(canonicalRules, "canonicalRules");

/**
 * Two page shapes whose union fires all six canonical rules on a 200: one with
 * no canonical at all, one with a cross-host HTML canonical that disagrees with
 * the header, is declared twice, and sits next to a noindex.
 */
const BROKEN_CANONICALS = [
  { canonicalHtml: null, canonicalHeader: null, isIndexable: true },
  {
    canonicalHtml: "https://other.example/elsewhere",
    canonicalHeader: "https://example.com/header-says",
    canonicalCount: 2,
    robotsMeta: "noindex",
  },
];

describe("canonicalRules metadata", () => {
  it("defines exactly the six canonical rules of the Phase 2 table", () => {
    expect(canonicalRules.map((r) => r.id).sort()).toEqual(
      [
        "canonical.missing",
        "canonical.points-elsewhere",
        "canonical.multiple",
        "canonical.html-header-conflict",
        "canonical.cross-domain",
        "directive.canonical-noindex-conflict",
      ].sort(),
    );
  });

  it("claims exactly the checklist ids the table assigns", () => {
    expect(Object.fromEntries(canonicalRules.map((r) => [r.id, r.checkIds]))).toEqual({
      "canonical.missing": ["CHECK-16"],
      "canonical.points-elsewhere": ["CHECK-17"],
      "canonical.multiple": ["CHECK-18"],
      "canonical.html-header-conflict": ["CHECK-18"],
      "canonical.cross-domain": ["CHECK-20"],
      "directive.canonical-noindex-conflict": ["CHECK-21"],
    });
  });

  it("carries the severities the table assigns", () => {
    expect(Object.fromEntries(canonicalRules.map((r) => [r.id, r.severity]))).toEqual({
      "canonical.missing": "warning",
      "canonical.points-elsewhere": "info",
      "canonical.multiple": "critical",
      "canonical.html-header-conflict": "critical",
      "canonical.cross-domain": "warning",
      "directive.canonical-noindex-conflict": "critical",
    });
  });

  it("every rule is a page rule carrying copy and a ruleset version", () => {
    for (const r of canonicalRules) {
      expect(r.kind, r.id).toBe("page");
      expect(r.category, r.id).toBe("canonical");
      expect(r.title.length, r.id).toBeGreaterThan(5);
      expect(r.rulesetVersion, r.id).toBeTruthy();
    }
  });

  it("no rule fires on the clean, self-canonical page", () => {
    for (const r of canonicalRules) expect(r.run(mkPage()), r.id).toHaveLength(0);
  });

  it("no rule fires on a page that was not fetched as a 200 OK", () => {
    expectSilentOnNonOkFetches(canonicalRules, BROKEN_CANONICALS);
  });
});

describe("canonical.missing", () => {
  it("fires when an indexable page declares no canonical anywhere", () => {
    const f = rule("canonical.missing").run(
      mkPage({ canonicalHtml: null, canonicalHeader: null }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.ruleId).toBe("canonical.missing");
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.dedupeKey).toBe("https://example.com/page");
  });

  it("is silent when only the HTTP header declares one", () => {
    expect(
      rule("canonical.missing").run(
        mkPage({ canonicalHtml: null, canonicalHeader: "https://example.com/page" }),
      ),
    ).toHaveLength(0);
  });

  // `<link rel=canonical href="">` reaches the database as an empty string. It
  // declares no URL, so it is an absent canonical, not a self-canonical — and
  // without this every canonical rule would read it as "fine" and say nothing.
  it("counts a blank declaration as no declaration", () => {
    for (const blank of ["", "   "]) {
      expect(
        rule("canonical.missing").run(mkPage({ canonicalHtml: blank, canonicalHeader: null })),
        JSON.stringify(blank),
      ).toHaveLength(1);
      expect(
        rule("canonical.missing").run(mkPage({ canonicalHtml: null, canonicalHeader: blank })),
        JSON.stringify(blank),
      ).toHaveLength(1);
    }
  });

  it("falls through a blank HTML canonical to a real header canonical", () => {
    expect(
      rule("canonical.missing").run(
        mkPage({ canonicalHtml: "", canonicalHeader: "https://example.com/page" }),
      ),
    ).toHaveLength(0);
  });

  // Edge case from the table: a page that is not going into the index does not
  // need a canonical, so the absence is not a finding.
  it("is silent on a non-indexable page, and when indexability is unknown", () => {
    const bare = { canonicalHtml: null, canonicalHeader: null };
    expect(
      rule("canonical.missing").run(mkPage({ ...bare, isIndexable: false })),
    ).toHaveLength(0);
    expect(
      rule("canonical.missing").run(mkPage({ ...bare, isIndexable: null })),
    ).toHaveLength(0);
  });
});

describe("canonical.points-elsewhere", () => {
  it("fires on an absolute canonical for another URL", () => {
    const f = rule("canonical.points-elsewhere").run(
      mkPage({ canonicalHtml: "https://example.com/other" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.evidence).toMatchObject({
      canonical: "https://example.com/other",
      resolvedTo: "https://example.com/other",
    });
  });

  // Edge case from the table.
  it("resolves a relative canonical against the page URL", () => {
    const f = rule("canonical.points-elsewhere").run(mkPage({ canonicalHtml: "/x" }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({
      canonical: "/x",
      resolvedTo: "https://example.com/x",
    });
  });

  it("is silent on a relative canonical that resolves to this page", () => {
    expect(rule("canonical.points-elsewhere").run(mkPage({ canonicalHtml: "/page" })))
      .toHaveLength(0);
    expect(rule("canonical.points-elsewhere").run(mkPage({ canonicalHtml: "page" })))
      .toHaveLength(0);
  });

  it("normalizes both sides: fragment and param order are not a difference", () => {
    for (const canonical of [
      "https://example.com/page#top",
      "https://EXAMPLE.com/page",
    ]) {
      expect(rule("canonical.points-elsewhere").run(mkPage({ canonicalHtml: canonical })), canonical)
        .toHaveLength(0);
    }
    expect(
      rule("canonical.points-elsewhere").run(
        mkPage({
          url: "https://example.com/p?b=2&a=1",
          canonicalHtml: "https://example.com/p?a=1&b=2",
        }),
      ),
    ).toHaveLength(0);
  });

  it("falls back to the header canonical when the HTML declares none", () => {
    const f = rule("canonical.points-elsewhere").run(
      mkPage({ canonicalHtml: null, canonicalHeader: "https://example.com/from-header" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ canonical: "https://example.com/from-header" });
  });

  it("prefers the HTML canonical over the header one", () => {
    const f = rule("canonical.points-elsewhere").run(
      mkPage({
        canonicalHtml: "https://example.com/from-html",
        canonicalHeader: "https://example.com/from-header",
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ canonical: "https://example.com/from-html" });
  });

  it("fires with unparseable: true on a canonical that resolves to no URL at all", () => {
    // Hostless, malformed, and non-HTTP schemes: none of these name a page.
    for (const canonical of [
      "http://",
      "http://[bad",
      "https://ex ample.com/",
      "javascript:void(0)",
      "mailto:hello@example.com",
    ]) {
      const f = rule("canonical.points-elsewhere").run(mkPage({ canonicalHtml: canonical }));
      expect(f, canonical).toHaveLength(1);
      expect(f[0]!.evidence, canonical).toMatchObject({
        canonical,
        resolvedTo: null,
        unparseable: true,
      });
    }
  });

  it("treats a stray string as the relative path a browser would resolve it to", () => {
    // "not a url" is a valid relative reference; it is not unparseable, it is a
    // canonical pointing at /not%20a%20url. Reporting it as malformed would be
    // a guess about intent.
    const f = rule("canonical.points-elsewhere").run(mkPage({ canonicalHtml: "not a url" }));
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({
      canonical: "not a url",
      resolvedTo: "https://example.com/not%20a%20url",
    });
    expect(f[0]!.evidence).not.toHaveProperty("unparseable");
  });

  it("is silent when no canonical is declared — that is canonical.missing's job", () => {
    expect(
      rule("canonical.points-elsewhere").run(
        mkPage({ canonicalHtml: null, canonicalHeader: null }),
      ),
    ).toHaveLength(0);
    // A blank href declares nothing either, so it is not a canonical pointing
    // at this page — canonical.missing has it.
    expect(
      rule("canonical.points-elsewhere").run(
        mkPage({ canonicalHtml: "", canonicalHeader: null }),
      ),
    ).toHaveLength(0);
  });
});

describe("canonical.multiple", () => {
  it("boundary: 2 fires, 1 and 0 do not", () => {
    const f = rule("canonical.multiple").run(mkPage({ canonicalCount: 2 }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe(rule("canonical.multiple").severity);
    expect(f[0]!.evidence).toMatchObject({
      canonicalCount: 2,
      kept: "https://example.com/page",
    });
    expect(rule("canonical.multiple").run(mkPage({ canonicalCount: 1 }))).toHaveLength(0);
    expect(rule("canonical.multiple").run(mkPage({ canonicalCount: 0 }))).toHaveLength(0);
  });

  it("reports the canonical that was kept, even when it points elsewhere", () => {
    const f = rule("canonical.multiple").run(
      mkPage({ canonicalCount: 3, canonicalHtml: "https://example.com/first" }),
    );
    expect(f[0]!.evidence).toMatchObject({ canonicalCount: 3, kept: "https://example.com/first" });
  });
});

describe("canonical.html-header-conflict", () => {
  it("fires when the HTML and the header name different URLs", () => {
    const f = rule("canonical.html-header-conflict").run(
      mkPage({
        canonicalHtml: "https://example.com/html-one",
        canonicalHeader: "https://example.com/header-one",
      }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe(rule("canonical.html-header-conflict").severity);
    expect(f[0]!.evidence).toMatchObject({
      htmlCanonical: "https://example.com/html-one",
      headerCanonical: "https://example.com/header-one",
    });
  });

  // Edge case from the table: the two declarations are spelled differently but
  // mean the same URL, so there is nothing for a search engine to resolve.
  it("is silent when the two agree after normalization", () => {
    for (const [html, header] of [
      ["/page", "https://example.com/page"],
      ["https://example.com/page#top", "https://example.com/page"],
      ["https://EXAMPLE.com/page", "https://example.com/page"],
      ["https://example.com/p?a=1&b=2", "https://example.com/p?b=2&a=1"],
    ]) {
      expect(
        rule("canonical.html-header-conflict").run(
          mkPage({ canonicalHtml: html, canonicalHeader: header }),
        ),
        `${html} vs ${header}`,
      ).toHaveLength(0);
    }
  });

  it("is silent unless both declarations are present", () => {
    expect(
      rule("canonical.html-header-conflict").run(
        mkPage({ canonicalHtml: "https://example.com/only-html", canonicalHeader: null }),
      ),
    ).toHaveLength(0);
    expect(
      rule("canonical.html-header-conflict").run(
        mkPage({ canonicalHtml: null, canonicalHeader: "https://example.com/only-header" }),
      ),
    ).toHaveLength(0);
    expect(
      rule("canonical.html-header-conflict").run(
        mkPage({ canonicalHtml: null, canonicalHeader: null }),
      ),
    ).toHaveLength(0);
    // One blank declaration is one declaration, and one declaration cannot
    // conflict with anything.
    expect(
      rule("canonical.html-header-conflict").run(
        mkPage({ canonicalHtml: "", canonicalHeader: "https://example.com/only-header" }),
      ),
    ).toHaveLength(0);
  });

  it("compares unresolvable values literally rather than collapsing them", () => {
    // Both sides fail to resolve, so both normalize to null. Comparing the
    // normalized values alone would call two different declarations identical;
    // the rule falls back to the literal text instead.
    expect(
      rule("canonical.html-header-conflict").run(
        mkPage({ canonicalHtml: "http://", canonicalHeader: "javascript:void(0)" }),
      ),
    ).toHaveLength(1);
    expect(
      rule("canonical.html-header-conflict").run(
        mkPage({ canonicalHtml: "http://", canonicalHeader: "http://" }),
      ),
    ).toHaveLength(0);
  });
});

describe("canonical.cross-domain", () => {
  it("fires when the canonical host differs from the page host", () => {
    const f = rule("canonical.cross-domain").run(
      mkPage({ canonicalHtml: "https://other.example/thing" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe(rule("canonical.cross-domain").severity);
    expect(f[0]!.evidence).toMatchObject({
      canonicalHost: "other.example",
      pageHost: "example.com",
    });
  });

  // Edge case from the table: www and apex are different hosts here. The rule
  // states the fact; whether it matters is the agent's call.
  it("treats www and apex as different hosts", () => {
    const f = rule("canonical.cross-domain").run(
      mkPage({ canonicalHtml: "https://www.example.com/page" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({
      canonicalHost: "www.example.com",
      pageHost: "example.com",
    });
  });

  it("is silent on a same-host canonical, whatever its path, scheme or case", () => {
    for (const canonical of [
      "https://example.com/somewhere-else",
      "/relative",
      "http://example.com/page",
      "https://EXAMPLE.COM/page",
    ]) {
      expect(
        rule("canonical.cross-domain").run(mkPage({ canonicalHtml: canonical })),
        canonical,
      ).toHaveLength(0);
    }
  });

  it("is silent when there is no canonical, or it resolves to no URL", () => {
    expect(
      rule("canonical.cross-domain").run(mkPage({ canonicalHtml: null, canonicalHeader: null })),
    ).toHaveLength(0);
    for (const canonical of ["http://", "javascript:void(0)"]) {
      expect(rule("canonical.cross-domain").run(mkPage({ canonicalHtml: canonical })), canonical)
        .toHaveLength(0);
    }
  });
});

describe("directive.canonical-noindex-conflict", () => {
  it("fires when a noindex page canonicalises elsewhere", () => {
    const f = rule("directive.canonical-noindex-conflict").run(
      mkPage({ canonicalHtml: "https://example.com/other", robotsMeta: "noindex, follow" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe(rule("directive.canonical-noindex-conflict").severity);
    expect(f[0]!.evidence).toMatchObject({
      canonical: "https://example.com/other",
      robotsMeta: "noindex, follow",
      xRobotsTag: null,
    });
  });

  it("fires when the noindex comes from the X-Robots-Tag header", () => {
    const f = rule("directive.canonical-noindex-conflict").run(
      mkPage({ canonicalHtml: "https://example.com/other", xRobotsTag: "noindex" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toMatchObject({ xRobotsTag: "noindex", robotsMeta: null });
  });

  // Edge case from the table: pointing at yourself while asking to be dropped
  // is consistent, not contradictory.
  it("is silent on a self-canonical noindex page", () => {
    expect(
      rule("directive.canonical-noindex-conflict").run(mkPage({ robotsMeta: "noindex" })),
    ).toHaveLength(0);
    expect(
      rule("directive.canonical-noindex-conflict").run(
        mkPage({ canonicalHtml: "/page", robotsMeta: "noindex" }),
      ),
    ).toHaveLength(0);
  });

  it("is silent when the page is indexable, whatever the canonical says", () => {
    expect(
      rule("directive.canonical-noindex-conflict").run(
        mkPage({ canonicalHtml: "https://example.com/other", robotsMeta: "index, follow" }),
      ),
    ).toHaveLength(0);
    expect(
      rule("directive.canonical-noindex-conflict").run(
        mkPage({ canonicalHtml: "https://example.com/other" }),
      ),
    ).toHaveLength(0);
  });

  it("is silent when no canonical is declared", () => {
    expect(
      rule("directive.canonical-noindex-conflict").run(
        mkPage({ canonicalHtml: null, canonicalHeader: null, robotsMeta: "noindex" }),
      ),
    ).toHaveLength(0);
  });

  // A malformed canonical is not known to point anywhere, so there is no
  // contradiction to report; canonical.points-elsewhere reports the malformation.
  it("is silent when the canonical does not resolve to a URL", () => {
    expect(
      rule("directive.canonical-noindex-conflict").run(
        mkPage({ canonicalHtml: "javascript:void(0)", robotsMeta: "noindex" }),
      ),
    ).toHaveLength(0);
  });
});

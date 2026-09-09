/**
 * The shared rule helpers. `present` and `queryFinding` are imported by rule
 * files across three directories, so they are tested here once rather than
 * incidentally through whichever rule happens to call them.
 */
import { describe, expect, it } from "vitest";

import {
  finding,
  isCanonicalisedElsewhere,
  metricRow,
  metricRule,
  present,
  queryFinding,
  resolveEffectiveCanonical,
  type MetricIdentity,
} from "../../src/rules/helpers.js";
import { ISSUE_COPY } from "../../src/rules/registry/copy/index.js";
import { RULESET_VERSION } from "../../src/rules/registry/registry.js";
import { mkPage } from "./mk-page.js";

describe("present", () => {
  it("is true only for a string with non-whitespace text", () => {
    expect(present("hello")).toBe(true);
    expect(present("  padded  ")).toBe(true);
  });

  it("is false for null, empty and whitespace-only values", () => {
    expect(present(null)).toBe(false);
    expect(present("")).toBe(false);
    expect(present("   ")).toBe(false);
    expect(present("\n\t")).toBe(false);
  });
});

describe("queryFinding", () => {
  it("stamps the rule's id and severity onto a site-scoped finding", () => {
    const f = queryFinding(
      { id: "sitemap.missing", severity: "warning" },
      { pageId: null, pageUrl: null, evidence: { note: "none declared" }, dedupeKey: "site" },
    );
    expect(f).toEqual({
      ruleId: "sitemap.missing",
      pageId: null,
      pageUrl: null,
      severity: "warning",
      evidence: { note: "none declared" },
      dedupeKey: "site",
    });
  });

  it("carries a page-scoped finding's page id and url through unchanged", () => {
    const f = queryFinding(
      { id: "links.broken-internal", severity: "critical" },
      {
        pageId: "page_1",
        pageUrl: "https://example.com/a",
        evidence: { statusCode: 404 },
        dedupeKey: "https://example.com/a",
      },
    );
    expect(f.pageId).toBe("page_1");
    expect(f.pageUrl).toBe("https://example.com/a");
    expect(f.severity).toBe("critical");
  });

  // The identity is the rule's, never the payload's. A caller that hands over
  // a row carrying its own `ruleId`/`severity` columns must not be able to
  // relabel the finding — and no stray column may ride along into the shape
  // the runner writes to `issues`.
  it("cannot be relabelled by a payload carrying its own ruleId or severity", () => {
    const payload = {
      pageId: "page_1",
      pageUrl: "https://example.com/a",
      evidence: { hops: 3 },
      dedupeKey: "https://example.com/a",
      ruleId: "some.other-rule",
      severity: "critical",
      stray: "not part of a finding",
    } as unknown as Parameters<typeof queryFinding>[1];

    const f = queryFinding({ id: "redirect.chain", severity: "warning" }, payload);

    expect(f.ruleId).toBe("redirect.chain");
    expect(f.severity).toBe("warning");
    expect(Object.keys(f).sort()).toEqual([
      "dedupeKey",
      "evidence",
      "pageId",
      "pageUrl",
      "ruleId",
      "severity",
    ]);
  });

  // The severity is single-sourced from the rule's identity, exactly as the
  // page-rule `finding` does it — the two helpers must not drift apart.
  it("takes severity from the rule identity, like the page-rule twin", () => {
    const self = { id: "some.rule", severity: "info" as const };
    const page = mkPage();
    expect(finding(self, page, {}).severity).toBe("info");
    expect(
      queryFinding(self, { pageId: page.id, pageUrl: page.url, evidence: {}, dedupeKey: page.url })
        .severity,
    ).toBe("info");
  });
});

/**
 * The canonical exclusion every rule that must not judge a canonicalised page
 * reads (Phase 19 §1). It is one line over `resolveEffectiveCanonical` on
 * purpose — the SAME resolution `canonical.points-elsewhere` reports from — so
 * these cases are as much a pin on that agreement as on the helper: a page this
 * says nothing about is a page that rule files a finding for, and never the
 * reverse.
 */
describe("isCanonicalisedElsewhere", () => {
  const at = (url: string, canonical: Partial<Record<"canonicalHtml" | "canonicalHeader", string | null>> = {}) =>
    mkPage({ url, urlNormalised: url, canonicalHtml: null, canonicalHeader: null, ...canonical });

  const SELF = "https://example.com/page";

  it("is false for a page that canonicalises to itself", () => {
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHtml: SELF }))).toBe(false);
  });

  it("is false for a page that declares no canonical at all", () => {
    expect(isCanonicalisedElsewhere(at(SELF))).toBe(false);
  });

  it("is true when the declared canonical names another URL", () => {
    expect(
      isCanonicalisedElsewhere(at(SELF, { canonicalHtml: "https://example.com/other" })),
    ).toBe(true);
  });

  it("reads the HTTP header when there is no HTML canonical, and judges it the same way", () => {
    expect(
      isCanonicalisedElsewhere(at(SELF, { canonicalHeader: "https://example.com/other" })),
    ).toBe(true);
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHeader: SELF }))).toBe(false);
  });

  // Blank is "not declared", everywhere in the rule layer (`present`). An empty
  // href that read as a declaration would make every page carrying one
  // invisible to the rules that skip canonicalised pages — the always-passes
  // hole hard rule 1 forbids, arrived at from the other direction.
  it("treats an empty or whitespace-only canonical as no declaration", () => {
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHtml: "" }))).toBe(false);
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHtml: "   " }))).toBe(false);
    // Blank HTML, real header: the header is what the page declares.
    expect(
      isCanonicalisedElsewhere(
        at(SELF, { canonicalHtml: "  ", canonicalHeader: "https://example.com/other" }),
      ),
    ).toBe(true);
  });

  it("resolves a relative canonical against the page before comparing", () => {
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHtml: "/page" }))).toBe(false);
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHtml: "/other" }))).toBe(true);
  });

  // The normalizer settles fragment, host case and query-parameter order, so
  // none of the three is mistaken for "somewhere else".
  it("ignores the differences normalisation settles", () => {
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHtml: `${SELF}#top` }))).toBe(false);
    expect(
      isCanonicalisedElsewhere(at(SELF, { canonicalHtml: "https://EXAMPLE.com/page" })),
    ).toBe(false);
  });

  // A canonical that names nowhere is not a canonical that names somewhere
  // else: the page keeps its own signals and stays visible to every rule.
  // `normalizeUrl` refuses anything that is not http(s), which is the only way
  // a value fails to resolve — a garbage href resolves as a relative path.
  it("is false for a canonical that does not resolve to a web URL", () => {
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHtml: "javascript:void(0)" }))).toBe(
      false,
    );
    // And the other side of that: "not a url" IS a relative path, so it names
    // another URL on this host and the page is excluded. Stated here because it
    // is the surprising half.
    expect(isCanonicalisedElsewhere(at(SELF, { canonicalHtml: "not a url" }))).toBe(true);
  });

  it("answers exactly what canonical.points-elsewhere reports", () => {
    for (const canonical of [
      SELF,
      "https://example.com/other",
      "/page",
      "/other",
      "javascript:void(0)",
      "not a url",
    ]) {
      const page = at(SELF, { canonicalHtml: canonical });
      expect(isCanonicalisedElsewhere(page), canonical).toBe(
        resolveEffectiveCanonical(page)?.pointsElsewhere === true,
      );
    }
  });
});

describe("metricRow", () => {
  it("stamps the rule's id and defaults a site-scoped row's scope value to the empty string", () => {
    const m = metricRow(
      { id: "indexability.ratio" },
      { scope: "site", value: { indexable: 90, total: 100 } },
    );
    expect(m).toEqual({
      metricId: "indexability.ratio",
      scope: "site",
      scopeValue: "",
      value: { indexable: 90, total: 100 },
    });
  });

  it("carries a cohort row's scope value through unchanged", () => {
    const m = metricRow(
      { id: "depth.distribution" },
      { scope: "page_type", scopeValue: "product", value: { median: 3 } },
    );
    expect(m.scope).toBe("page_type");
    expect(m.scopeValue).toBe("product");
    expect(m.value).toEqual({ median: 3 });
  });

  it("carries a sitemap document's URL through as the scope value", () => {
    // The scope that is not a cohort of pages: a `sitemap_doc` row answers for
    // one document, named by the URL it was fetched from.
    const m = metricRow(
      { id: "sitemap.structure" },
      {
        scope: "sitemap_doc",
        scopeValue: "https://example.com/sitemap-products.xml",
        value: { urls: 3, breaches50k: false },
      },
    );
    expect(m.scope).toBe("sitemap_doc");
    expect(m.scopeValue).toBe("https://example.com/sitemap-products.xml");
    expect(m.value).toEqual({ urls: 3, breaches50k: false });
  });

  // The identity is the rule's, never the payload's — `queryFinding`'s reason,
  // with a sharper edge: the runner deletes a metric rule's rows by
  // `metric_id = <rule id>` before inserting its fresh set, so a row that
  // arrived under some other metric id would never be deleted and would sit in
  // `metrics` forever as state no rule recomputes.
  it("cannot be relabelled by a payload carrying its own metricId", () => {
    const payload = {
      scope: "site",
      value: { n: 1 },
      metricId: "some.other-metric",
      stray: "not part of a metric row",
    } as unknown as Parameters<typeof metricRow>[1];

    const m = metricRow({ id: "content.thin-share" }, payload);

    expect(m.metricId).toBe("content.thin-share");
    expect(Object.keys(m).sort()).toEqual(["metricId", "scope", "scopeValue", "value"]);
  });

  // Both rows the runner refuses are unrepresentable here: the parameter is a
  // discriminated union, so a site row cannot carry a name and a cohort row
  // cannot lack one. The assertion is the typecheck itself — `@ts-expect-error`
  // fails `tsc` if either line ever starts compiling.
  it("makes a named site row and a nameless cohort row impossible to build", () => {
    // @ts-expect-error a site-scoped metric has one row per crawl and names nothing
    expect(metricRow({ id: "some.metric" }, { scope: "site", scopeValue: "x", value: {} })).toBeTruthy();
    // @ts-expect-error a page_type row must name the cohort it answers for
    expect(metricRow({ id: "some.metric" }, { scope: "page_type", value: {} })).toBeTruthy();
    // @ts-expect-error and a sitemap_doc row must name its document
    expect(metricRow({ id: "some.metric" }, { scope: "sitemap_doc", value: {} })).toBeTruthy();
  });
});

describe("metricRule", () => {
  // The id is written once and reaches the body as `self`, so a rule cannot
  // stamp its rows with an id different from the one the runner deletes by.
  it("hands the body its own identity, and it is the registered id", async () => {
    let seen: MetricIdentity | undefined;
    const rule = metricRule("inlinks.distribution", ["CHECK-33"], "links", async (_db, _crawl, self) => {
      seen = self;
      return [metricRow(self, { scope: "site", value: { n: 1 } })];
    });

    const rows = await rule.run(undefined as never, "crawl_1");
    expect(seen).toEqual({ id: "inlinks.distribution" });
    expect(rows).toEqual([
      { metricId: "inlinks.distribution", scope: "site", scopeValue: "", value: { n: 1 } },
    ]);
  });

  // Not a default the caller may override — the kind has one severity, because
  // a metric states a number and accuses no one.
  it("registers as a metric rule that is always info, with the rule's own copy", () => {
    const rule = metricRule("structure.depth-distribution", ["CHECK-31"], "technical", async () => []);
    expect(rule.kind).toBe("metric");
    expect(rule.severity).toBe("info");
    expect(rule.category).toBe("technical");
    expect(rule.checkIds).toEqual(["CHECK-31"]);
    expect(rule.rulesetVersion).toBe(RULESET_VERSION);
    expect(rule.title).toBe(ISSUE_COPY["structure.depth-distribution"]!.title);
  });

  // Copy is looked up at definition time, so a metric with none fails when the
  // module loads rather than rendering as an unlabelled table.
  it("refuses to define a metric that has no copy", () => {
    expect(() => metricRule("no.such-metric", ["CHECK-31"], "links", async () => [])).toThrow(
      /no copy for rule 'no.such-metric'/,
    );
  });
});

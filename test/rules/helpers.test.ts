/**
 * The shared rule helpers. `present` and `queryFinding` are imported by rule
 * files across three directories, so they are tested here once rather than
 * incidentally through whichever rule happens to call them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { closeDb, createDb, type Db } from "../../src/db/client.js";
import {
  CANONICALISED_ELSEWHERE,
  finding,
  isJudged,
  JUDGED,
  indexabilityOf,
  isCanonicalisedElsewhere,
  metricRow,
  metricRule,
  present,
  queryFinding,
  resolveEffectiveCanonical,
  parseRobotsDate,
  robotsTokens,
  unavailableAfterOf,
  type MetricIdentity,
} from "../../src/rules/helpers.js";
import { FETCH_CLASSES } from "../../src/crawl/fetch-page.js";
import { perScope } from "../../src/rules/registry/metric-table.js";
import type { PageRecord } from "../../src/rules/registry/types.js";
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

/**
 * The SQL form of the same test, run through Postgres and compared with the
 * TypeScript one case by case.
 *
 * WHY IT IS RUN AND NOT READ. `CANONICALISED_ELSEWHERE` is a string of SQL —
 * `split_part`, `substring`, an array containment — and nothing about reading
 * it says what Postgres does with `https://EXAMPLE.com/page#top`. The two forms
 * gate the same rules (a page invisible to the duplicate rules in SQL is a page
 * invisible to the hreflang rules in TypeScript), so an unpinned disagreement
 * is a page judged one way by one rule and another way by the next.
 *
 * The rows go through `values`, not through a table: this asserts what one
 * expression answers about four column values and needs no crawl, no
 * migrations, and nothing it could leave behind on a shared database.
 */
describe("CANONICALISED_ELSEWHERE agrees with isCanonicalisedElsewhere", () => {
  let db: Db;

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
    db = createDb(url);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  /** One case: the page's URL, and what it declares as its canonical. */
  interface Case {
    url: string;
    canonical: string | null;
    why: string;
  }

  /** What the SQL expression answers for each case, in the order given. */
  async function sqlAnswers(cases: Case[]): Promise<boolean[]> {
    const rows = cases.map(
      (c, i) =>
        sql`(${String(i)}, ${c.url}, ${c.url.toLowerCase().replace(/\/$/, "")}, ${c.canonical}, ${null})`,
    );
    // `p` carries the four columns the expression reads, plus an ordinal so the
    // answers come back in the order the table states them.
    const result = await db.execute<{ i: string; elsewhere: boolean }>(sql`
      select p.i, ${CANONICALISED_ELSEWHERE("p")} as elsewhere
      from (values ${sql.join(rows, sql`, `)})
        as p(i, url, url_normalised, canonical_html, canonical_header)
      order by p.i::int`);
    return result.rows.map((r) => r.elsewhere);
  }

  const tsAnswer = (c: Case): boolean =>
    isCanonicalisedElsewhere({
      url: c.url,
      canonicalHtml: c.canonical,
      canonicalHeader: null,
    });

  const SELF = "https://example.com/page";

  /**
   * The cases the two forms must answer IDENTICALLY. Everything a template
   * emits is here, plus the five spellings that used to make a self-canonical
   * read as "elsewhere" — the wrong "yes" that dropped the page from both
   * duplicate rules and every hreflang rule in silence (hard rule 1).
   */
  const AGREE: Case[] = [
    { url: SELF, canonical: SELF, why: "self, spelled identically" },
    { url: SELF, canonical: null, why: "declares nothing" },
    { url: SELF, canonical: "", why: "an empty href declares nothing" },
    { url: SELF, canonical: "   ", why: "whitespace declares nothing" },
    { url: SELF, canonical: "https://example.com/other", why: "another URL on this host" },
    { url: SELF, canonical: "https://other.example/page", why: "another host" },
    { url: SELF, canonical: `${SELF}#top`, why: "a fragment is not a difference" },
    { url: SELF, canonical: "https://EXAMPLE.com/page", why: "host case is not a difference" },
    { url: SELF, canonical: "HTTPS://Example.COM/page", why: "scheme case is not either" },
    { url: SELF, canonical: "https://example.com:443/page", why: "the default port is dropped" },
    {
      url: "http://example.com/page",
      canonical: "http://example.com:80/page",
      why: "and dropped for http too",
    },
    {
      url: "https://example.com/page?a=1&b=2",
      canonical: "https://example.com/page?b=2&a=1",
      why: "parameter ORDER is not a difference (normalizeUrl sorts)",
    },
    {
      url: "https://example.com/page?a=1&b=2",
      canonical: "https://example.com/page?a=1&b=3",
      why: "a parameter VALUE is",
    },
    { url: SELF, canonical: `${SELF}?`, why: "an empty query is not a difference" },
    {
      url: "https://example.com/page?a=1",
      canonical: "https://example.com/page?a=1&",
      why: "nor is a trailing separator",
    },
    { url: SELF, canonical: `${SELF}/`, why: "a trailing slash IS a different URL" },
    { url: SELF, canonical: "https://example.com/Page", why: "and so is a path's case" },
    { url: "https://example.com/", canonical: "https://example.com", why: "an empty path is /" },
    { url: SELF, canonical: "javascript:void(0)", why: "not a web URL: names nowhere" },
  ];

  it("answers exactly what the TypeScript form answers, case for case", async () => {
    const sqlSaid = await sqlAnswers(AGREE);
    expect(sqlSaid).toHaveLength(AGREE.length);
    AGREE.forEach((c, i) => {
      const ts = tsAnswer(c);
      expect(sqlSaid[i], `${c.why}: ${c.url} -> ${String(c.canonical)}`).toBe(ts);
    });
  });

  /**
   * And the cases the two forms do NOT answer identically, pinned in the one
   * direction that is safe: SQL says "not elsewhere" where TypeScript says
   * "elsewhere", so the page stays VISIBLE to the rules and at worst carries a
   * finding a reader can dismiss. The reverse — SQL silencing a page
   * TypeScript would have judged — is the always-passes hole hard rule 1
   * forbids, and this test is what would catch one appearing.
   */
  const SQL_ABSTAINS: Case[] = [
    { url: SELF, canonical: "/other", why: "relative: SQL has no base to resolve against" },
    { url: SELF, canonical: "not a url", why: "a relative path, for the same reason" },
    {
      url: "https://example.com/a/page",
      canonical: "https://example.com/a/../page",
      why: "a dot segment: new URL resolves it, SQL abstains",
    },
    {
      url: SELF,
      canonical: "https://example.com/pa ge",
      why: "a raw space: new URL percent-encodes it, SQL abstains",
    },
    {
      url: SELF,
      canonical: "https://exämple.com/page",
      why: "non-ASCII: new URL punycodes the host, SQL abstains",
    },
    {
      url: "https://example.com/page?a=2&a=1",
      canonical: "https://example.com/page?a=1&a=2",
      why: "a repeated key: searchParams.sort is stable, a set is not ordered",
    },
  ];

  it("abstains rather than guessing, and only ever in the direction that keeps a page visible", async () => {
    const sqlSaid = await sqlAnswers(SQL_ABSTAINS);
    SQL_ABSTAINS.forEach((c, i) => {
      expect(tsAnswer(c), `${c.why}: the TypeScript form says elsewhere`).toBe(true);
      expect(sqlSaid[i], `${c.why}: the SQL form must abstain, never silence`).toBe(false);
    });
  });

  /**
   * The property behind both tables, stated once over every case in the file:
   * the SQL form is never MORE willing to call a page canonicalised elsewhere
   * than the TypeScript form. A wrong "no" is a finding; a wrong "yes" is a
   * page nobody judged and nobody was told about.
   */
  it("never answers elsewhere where the TypeScript form answers self", async () => {
    const all = [...AGREE, ...SQL_ABSTAINS];
    const sqlSaid = await sqlAnswers(all);
    all.forEach((c, i) => {
      if (sqlSaid[i] === true) {
        expect(tsAnswer(c), `SQL says elsewhere and TypeScript does not: ${c.why}`).toBe(true);
      }
    });
  });
});

/**
 * THE JUDGED COHORT (Phase 22 §1), both halves, against each other.
 *
 * The four exclusions one at a time in TypeScript, then the same rows through
 * Postgres: `isJudged` gates every on-page, technical and structured-data rule
 * and `JUDGED` gates every query and metric rule that asks the same question of
 * a group, so a page the two disagreed about would be judged by one rule and
 * invisible to the next — the drift the `CANONICALISED_ELSEWHERE` pin above
 * exists to catch, one exclusion wider.
 */
describe("isJudged", () => {
  /** The judged page: fetched OK, 200, indexable, canonical naming itself. */
  const judged = (over: Partial<PageRecord> = {}): PageRecord => mkPage(over);

  it("admits a fetched, 200, indexable, self-canonical page", () => {
    expect(isJudged(judged())).toBe(true);
    // And with no canonical at all: declaring nothing is not deferring to
    // anything, which is `isCanonicalisedElsewhere`'s own reading.
    expect(isJudged(judged({ canonicalHtml: null, canonicalHeader: null }))).toBe(true);
  });

  it("excludes a page that was not fetched OK", () => {
    expect(isJudged(judged({ fetchClass: "non_html" }))).toBe(false);
  });

  it("excludes a page that did not answer 200", () => {
    expect(isJudged(judged({ statusCode: 204 }))).toBe(false);
  });

  it("excludes a noindexed page, by the stored flag the writer stamps", () => {
    expect(isJudged(judged({ robotsMeta: "noindex, follow", isIndexable: false }))).toBe(false);
    // A null flag is not a yes. No crawl this engine writes produces one, and
    // the honest answer to "may this page be judged" is not a guess.
    expect(isJudged(judged({ isIndexable: null }))).toBe(false);
  });

  it("excludes a page canonicalised elsewhere, from either channel", () => {
    expect(isJudged(judged({ canonicalHtml: "https://example.com/other" }))).toBe(false);
    expect(
      isJudged(judged({ canonicalHtml: null, canonicalHeader: "https://example.com/other" })),
    ).toBe(false);
  });
});

/**
 * The SQL form of the cohort, run through Postgres and compared with the
 * TypeScript one case by case — `CANONICALISED_ELSEWHERE`'s test above, over
 * the whole predicate. Same `values` table, same reason: this asserts what one
 * expression answers about six column values and needs no crawl, no migrations,
 * and nothing it could leave behind on a shared database.
 */
describe("JUDGED agrees with isJudged", () => {
  let db: Db;

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set for db tests (no fallback)");
    db = createDb(url);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  const SELF = "https://example.com/page";

  /** One case: the six columns the two forms read, and what it is for. */
  interface JudgedCase {
    fetchClass: string;
    statusCode: number | null;
    isIndexable: boolean | null;
    canonicalHtml: string | null;
    canonicalHeader: string | null;
    why: string;
  }

  const base = (over: Partial<JudgedCase>, why: string): JudgedCase => ({
    fetchClass: "ok",
    statusCode: 200,
    isIndexable: true,
    canonicalHtml: SELF,
    canonicalHeader: null,
    why,
    ...over,
  });

  const CASES: JudgedCase[] = [
    base({}, "the judged page"),
    base({ canonicalHtml: null }, "declares no canonical"),
    base({ canonicalHtml: `${SELF}#top` }, "a fragment is not a difference"),
    base({ fetchClass: "non_html" }, "not fetched as HTML"),
    base({ fetchClass: "redirect", statusCode: 301, isIndexable: false }, "a redirect"),
    base({ fetchClass: "client_error", statusCode: 404, isIndexable: false }, "a 404"),
    base({ statusCode: 204, isIndexable: false }, "an ok that is not a 200"),
    base({ isIndexable: false }, "noindex"),
    base({ isIndexable: null }, "a flag no writer wrote"),
    base({ canonicalHtml: "https://example.com/other" }, "canonicalised elsewhere, html"),
    base(
      { canonicalHtml: null, canonicalHeader: "https://example.com/other" },
      "canonicalised elsewhere, header",
    ),
    base({ isIndexable: false, canonicalHtml: "https://example.com/other" }, "both at once"),
  ];

  it("answers exactly what the TypeScript form answers, case for case", async () => {
    const rows = CASES.map(
      (c, i) =>
        // Every column cast: a `values` list's parameters arrive untyped, and
        // `status_code = 200` against an unknown is the error this would
        // otherwise be — not a wrong answer, but not a test either.
        sql`(${String(i)}, ${SELF}::text, ${c.fetchClass}::text, ${c.statusCode}::int, ${c.isIndexable}::boolean, ${c.canonicalHtml}::text, ${c.canonicalHeader}::text)`,
    );
    const result = await db.execute<{ i: string; judged: boolean }>(sql`
      select p.i, ${JUDGED("p")} as judged
      from (values ${sql.join(rows, sql`, `)})
        as p(i, url, fetch_class, status_code, is_indexable, canonical_html, canonical_header)
      order by p.i::int`);
    const sqlSaid = result.rows.map((r) => r.judged);
    expect(sqlSaid).toHaveLength(CASES.length);
    // NULL WHERE THE FLAG IS NULL, and pinned rather than glossed: the SQL form
    // is a plain conjunction — `coalesce(…, false)` around it would cost the
    // three partial duplicate indexes their usability, which is measured at
    // `JUDGED`'s docblock — so a null `is_indexable` leaves it NULL. Every
    // caller uses it in a WHERE, where NULL and false do the same thing; the
    // rule that follows from this row is that nothing may NEGATE it.
    const nullCase = CASES.findIndex((c) => c.isIndexable === null);
    expect(sqlSaid[nullCase], "a null flag must not read as a judged page").not.toBe(true);
    CASES.forEach((c, i) => {
      const ts = isJudged({
        url: SELF,
        fetchClass: c.fetchClass,
        statusCode: c.statusCode,
        isIndexable: c.isIndexable,
        canonicalHtml: c.canonicalHtml,
        canonicalHeader: c.canonicalHeader,
      } as PageRecord);
      // `=== true` is what a WHERE clause does with this expression, and is
      // therefore the comparison the two forms have to agree on.
      expect(sqlSaid[i] === true, `${c.why}`).toBe(ts);
    });
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
    const rule = metricRule(
      "inlinks.distribution",
      ["CHECK-33"],
      "links",
      perScope("Template", [{ key: "n", label: "N" }]),
      async (_db, _crawl, self) => {
        seen = self;
        return [metricRow(self, { scope: "site", value: { n: 1 } })];
      },
    );

    const rows = await rule.run(undefined as never, "crawl_1");
    expect(seen).toEqual({ id: "inlinks.distribution" });
    expect(rows).toEqual([
      { metricId: "inlinks.distribution", scope: "site", scopeValue: "", value: { n: 1 } },
    ]);
  });

  // Not a default the caller may override — the kind has one severity, because
  // a metric states a number and accuses no one.
  it("registers as a metric rule that is always info, with the rule's own copy", () => {
    const rule = metricRule(
      "structure.depth-distribution",
      ["CHECK-31"],
      "technical",
      perScope("Template", [{ key: "n", label: "N" }]),
      async () => [],
    );
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
    expect(() =>
      metricRule(
        "no.such-metric",
        ["CHECK-31"],
        "links",
        perScope("Template", [{ key: "n", label: "N" }]),
        async () => [],
      ),
    ).toThrow(/no copy for rule 'no.such-metric'/);
  });
});

/**
 * `indexabilityOf` — the two standard columns every finding row on the API
 * surface is labelled with.
 *
 * The whole ruleset's reports are read through this function, so it is tested
 * over the WHOLE `FETCH_CLASSES` vocabulary rather than over a sample: a class
 * added to the crawler and not to the precedence is a row that would otherwise
 * be labelled by whatever the last `case` happened to be.
 */
describe("indexabilityOf", () => {
  /** A page that is not `ok`: `is_indexable` is false on every one of them. */
  const notOk = (fetchClass: string, over: Partial<PageRecord> = {}): PageRecord =>
    mkPage({ fetchClass, isIndexable: false, ...over });

  it("answers Indexable with no reason for a 200 that declares nothing", () => {
    expect(indexabilityOf(mkPage())).toEqual({ indexability: "Indexable", status: "" });
  });

  it("names a class for every member of the crawler's vocabulary", () => {
    // NOT a hand-written sample: every class the fetch layer can write is a
    // class a finding row can carry, and the default branch throws rather than
    // labelling one by accident.
    for (const fetchClass of FETCH_CLASSES) {
      if (fetchClass === "ok") continue;
      const answer = indexabilityOf(
        notOk(fetchClass, { statusCode: fetchClass === "redirect" ? 301 : 404 }),
      );
      expect(answer.indexability, `${fetchClass} was called indexable`).toBe("Non-Indexable");
      expect(answer.status, `${fetchClass} produced no reason`).not.toBe("");
    }
    // `ok` is the only class that can be indexable, and it is the only one with
    // an empty status — the two statements are one fact, and asserting it here
    // is what makes the loop above exhaustive rather than merely long.
    expect(indexabilityOf(mkPage())).toEqual({ indexability: "Indexable", status: "" });
  });

  it("maps each fetch class to the status a reader acts on", () => {
    const status = (fetchClass: string, statusCode: number | null): string =>
      indexabilityOf(notOk(fetchClass, { statusCode })).status;

    expect(status("redirect", 301)).toBe("Redirected");
    expect(status("client_error", 404)).toBe("Client Error");
    expect(status("server_error", 500)).toBe("Server Error");
    expect(status("blocked", 403)).toBe("Blocked by bot protection");
    expect(status("disallowed", null)).toBe("Blocked by robots.txt");
    expect(status("timeout", null)).toBe("No Response");
    expect(status("network_error", null)).toBe("No Response");
    expect(status("non_html", 200)).toBe("Not HTML");
    // Two more that produced no readable HTML, grouped with `non_html` because
    // the consequence is identical: no body was analysed, so there is nothing
    // to judge indexability from. `fetchClass` is where a reader finds out
    // which of the three it was.
    expect(status("too_large", 200)).toBe("Not HTML");
    expect(status("unsupported_encoding", 200)).toBe("Not HTML");
  });

  it("names a block a block, whatever status the challenge was served with", () => {
    // A block is the site refusing THIS CLIENT — a cf-mitigated header, a
    // 401/403/429, a challenge body on a 200 or a 503. robots.txt said nothing,
    // and we did get an answer, so it is neither of those two statuses; and it
    // is not read off the wire status either, because a 200 challenge printed
    // as `Client Error` contradicts the status column beside it on the very
    // rule (crawl.blocked) whose subject is that distinction.
    for (const statusCode of [403, 429, 401, 200, 503, null]) {
      expect(
        indexabilityOf(notOk("blocked", { statusCode })).status,
        `blocked ${String(statusCode)} was not read as a block`,
      ).toBe("Blocked by bot protection");
    }
  });

  it("reads an ok row that is not a 200 as no HTML to judge", () => {
    expect(indexabilityOf(mkPage({ statusCode: 204, isIndexable: false })).status).toBe(
      "Not HTML",
    );
    // And it is checked against the stored column like every other `ok` row:
    // the writer requires the 200 too, so a `true` beside a 204 is the same
    // writer defect as a `true` beside a noindex, not a row that escapes the
    // audit because it returned early.
    expect(() => indexabilityOf(mkPage({ statusCode: 204, isIndexable: true }))).toThrow(
      /must agree about indexability/,
    );
  });

  it("puts noindex ahead of the canonical when a 200 carries both", () => {
    // The only pair that overlaps on a 200, and THE ORDER THE WHOLE SURFACE
    // USES: a noindex is the page's own explicit instruction to stay out of
    // the index, while a canonical is a hint about which URL to prefer, and
    // search engines treat the explicit directive as the stronger signal. This
    // page is `Noindex` here, counted under `urlsNoindex` by `site.health`
    // (test/rules/health-metrics.test.ts) and reported with
    // `reason: "noindex"` by `sitemap.non-indexable`
    // (test/rules/sitemap-query.test.ts). One vocabulary, three places.
    const both = mkPage({
      robotsMeta: "noindex",
      canonicalHtml: "https://example.com/other",
      isIndexable: false,
    });
    expect(indexabilityOf(both)).toEqual({ indexability: "Non-Indexable", status: "Noindex" });
  });

  it("reads noindex off either robots channel, and `none` as noindex", () => {
    for (const page of [
      mkPage({ robotsMeta: "noindex", isIndexable: false }),
      mkPage({ xRobotsTag: "noindex", isIndexable: false }),
      mkPage({ robotsMeta: "max-snippet:-1, noindex, nofollow", isIndexable: false }),
      mkPage({ robotsMeta: "none", isIndexable: false }),
    ]) {
      expect(indexabilityOf(page).status).toBe("Noindex");
    }
    // And a directive that is not one: `nonevent` is not `none`.
    expect(indexabilityOf(mkPage({ robotsMeta: "nonevent" })).status).toBe("");
  });

  it("calls a 200 whose canonical names another URL Canonicalised", () => {
    const page = mkPage({ canonicalHtml: "https://example.com/other" });
    expect(indexabilityOf(page)).toEqual({
      indexability: "Non-Indexable",
      status: "Canonicalised",
    });
    // The HTTP header is the second channel, and a self-canonical is not
    // "elsewhere" however it is spelled.
    expect(
      indexabilityOf(mkPage({ canonicalHtml: null, canonicalHeader: "https://example.com/x" }))
        .status,
    ).toBe("Canonicalised");
    expect(
      indexabilityOf(mkPage({ canonicalHtml: "https://example.com/page#top" })).status,
    ).toBe("");
  });

  it("keeps the crawler's is_indexable column honest, and exempts the one case it cannot see", () => {
    // A canonicalised page IS crawled and indexable — it has handed its signals
    // elsewhere — so `is_indexable: true` beside `Non-Indexable` is right, and
    // the check must not fire on it.
    expect(() =>
      indexabilityOf(mkPage({ canonicalHtml: "https://example.com/other", isIndexable: true })),
    ).not.toThrow();
    // Everything else: a stored column that contradicts the directives on the
    // row is a writer defect, and it is LOUD rather than silently resolved one
    // way (hard rule 7).
    expect(() => indexabilityOf(mkPage({ robotsMeta: "noindex", isIndexable: true }))).toThrow(
      /is_indexable/,
    );
    expect(() => indexabilityOf(mkPage({ isIndexable: false }))).toThrow(/is_indexable/);
    // Null asserts nothing: it is the column's value on every page that was
    // never fetched as HTML.
    expect(() => indexabilityOf(notOk("timeout", { isIndexable: null }))).not.toThrow();
  });

  it("refuses a fetch class it has never met rather than labelling it", () => {
    expect(() => indexabilityOf(mkPage({ fetchClass: "teapot" }))).toThrow(/unknown fetch_class/);
  });
});

describe("robotsTokens (26a)", () => {
  it("splits on commas, lower-cases and trims", () => {
    expect(robotsTokens(" NoIndex ,NoFollow,  max-snippet:-1 ")).toEqual([
      "noindex",
      "nofollow",
      "max-snippet:-1",
    ]);
  });

  it("is empty for null and for an empty or blank value", () => {
    expect(robotsTokens(null)).toEqual([]);
    expect(robotsTokens("")).toEqual([]);
    expect(robotsTokens(" , ")).toEqual([]);
  });

  it("drops a leading bot prefix and ignores which bot it named", () => {
    expect(robotsTokens("googlebot: nofollow, bingbot:noindex")).toEqual(["nofollow", "noindex"]);
  });

  it("keeps a value directive whole: its colon is not a bot prefix", () => {
    expect(robotsTokens("max-snippet:0, max-image-preview: none")).toEqual([
      "max-snippet:0",
      "max-image-preview:none",
    ]);
    expect(robotsTokens("googlebot: max-snippet:0")).toEqual(["max-snippet:0"]);
  });

  it("keeps unavailable_after as one token whose date holds colons and commas", () => {
    expect(
      robotsTokens("nofollow, unavailable_after: 25 Jun 2010 15:00:00 PST, noarchive"),
    ).toEqual(["nofollow", "unavailable_after: 25 jun 2010 15:00:00 pst", "noarchive"]);
    expect(robotsTokens("unavailable_after: Fri, 25 Jun 2010 15:00:00 GMT, nosnippet")).toEqual([
      "unavailable_after: fri, 25 jun 2010 15:00:00 gmt",
      "nosnippet",
    ]);
    // An unparseable date must not swallow the next directive.
    expect(robotsTokens("unavailable_after: soon, nofollow")).toEqual([
      "unavailable_after: soon",
      "nofollow",
    ]);
  });
});

describe("robotsTokens: whitespace delimiters (PR #22 review)", () => {
  it("splits whitespace-delimited directives, as saysNoindex reads them", () => {
    expect(robotsTokens("noindex nofollow")).toEqual(["noindex", "nofollow"]);
    expect(robotsTokens("noarchive none")).toEqual(["noarchive", "none"]);
  });

  it("splits commas and whitespace together, with extra whitespace and mixed case", () => {
    expect(robotsTokens("  NoIndex \t NOFOLLOW ,  noArchive   nosnippet ")).toEqual([
      "noindex",
      "nofollow",
      "noarchive",
      "nosnippet",
    ]);
  });

  it("keeps a value directive with a space after its colon as one token", () => {
    expect(robotsTokens("nosnippet, max-snippet: 50")).toEqual(["nosnippet", "max-snippet:50"]);
    expect(robotsTokens("noindex max-image-preview : LARGE max-video-preview: -1")).toEqual([
      "noindex",
      "max-image-preview:large",
      "max-video-preview:-1",
    ]);
    expect(robotsTokens("googlebot: noindex nofollow")).toEqual(["noindex", "nofollow"]);
  });

  it("keeps an unavailable_after date whole after a whitespace-delimited directive", () => {
    expect(robotsTokens("noindex unavailable_after: 25 Jun 2010 15:00:00 PST")).toEqual([
      "noindex",
      "unavailable_after: 25 jun 2010 15:00:00 pst",
    ]);
    expect(
      robotsTokens("NOINDEX  unavailable_after: Fri, 25 Jun 2010 15:00:00 GMT, nofollow"),
    ).toEqual(["noindex", "unavailable_after: fri, 25 jun 2010 15:00:00 gmt", "nofollow"]);
  });
});

describe("unavailableAfterOf (26a)", () => {
  it("returns the raw date, case and all, or null", () => {
    expect(unavailableAfterOf("noarchive, unavailable_after: 25 Jun 2010 15:00:00 PST")).toBe(
      "25 Jun 2010 15:00:00 PST",
    );
    expect(unavailableAfterOf("noarchive")).toBeNull();
    expect(unavailableAfterOf(null)).toBeNull();
  });
});

describe("parseRobotsDate (PR #22 review)", () => {
  const utc = (iso: string) => Date.parse(iso); // only ever called with an explicit Z

  /** Run `fn` with the process time zone set to `tz`, restoring it after. */
  function inZone<T>(tz: string, fn: () => T): T {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  }

  it("reads ISO 8601 with a zone exactly", () => {
    expect(parseRobotsDate("2010-06-25T15:00:00Z")).toEqual({
      at: utc("2010-06-25T15:00:00Z"),
      assumedUtc: false,
    });
    expect(parseRobotsDate("2010-06-25T15:00:00+02:00")).toEqual({
      at: utc("2010-06-25T13:00:00Z"),
      assumedUtc: false,
    });
    expect(parseRobotsDate("2010-06-25t15:00:00.250-0130")).toEqual({
      at: utc("2010-06-25T16:30:00.250Z"),
      assumedUtc: false,
    });
    expect(parseRobotsDate("2010-06-25T15:00z")).toEqual({
      at: utc("2010-06-25T15:00:00Z"),
      assumedUtc: false,
    });
  });

  it("reads a zone-less ISO date or date-time as UTC whatever the host zone, and says so", () => {
    // The host zone really moves: Date.parse of the same zone-less text differs.
    const local = ["America/Los_Angeles", "Asia/Tokyo"].map((tz) =>
      inZone(tz, () => Date.parse("2010-06-25T15:00:00")),
    );
    expect(local[0]).not.toBe(local[1]);
    for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
      inZone(tz, () => {
        expect(parseRobotsDate("2010-06-25T15:00:00"), tz).toEqual({
          at: utc("2010-06-25T15:00:00Z"),
          assumedUtc: true,
        });
        expect(parseRobotsDate("2010-06-25 15:00"), tz).toEqual({
          at: utc("2010-06-25T15:00:00Z"),
          assumedUtc: true,
        });
        expect(parseRobotsDate("2010-06-25"), tz).toEqual({
          at: utc("2010-06-25T00:00:00Z"),
          assumedUtc: true,
        });
      });
    }
  });

  it("reads RFC 1123, RFC 850 and RFC 822 forms with their zone names", () => {
    const at = utc("2010-06-25T15:00:00Z");
    expect(parseRobotsDate("Fri, 25 Jun 2010 15:00:00 GMT")).toEqual({ at, assumedUtc: false });
    expect(parseRobotsDate("fri, 25 jun 2010 15:00:00 utc")).toEqual({ at, assumedUtc: false });
    expect(parseRobotsDate("Friday, 25-Jun-10 15:00:00 GMT")).toEqual({ at, assumedUtc: false });
    expect(parseRobotsDate("25 Jun 2010 08:00:00 PDT")).toEqual({ at, assumedUtc: false });
    expect(parseRobotsDate("25 Jun 2010 07:00:00 PST")).toEqual({ at, assumedUtc: false });
    expect(parseRobotsDate("25 Jun 2010 10:00 EST")).toEqual({ at, assumedUtc: false });
    expect(parseRobotsDate("25 Jun 10 16:00:00 +0100")).toEqual({ at, assumedUtc: false });
    expect(parseRobotsDate("Fri, 25 Jun 2010 15:00:00 UT")).toEqual({ at, assumedUtc: false });
    // Two-digit years pivot at 70 (RFC 6265's rule): 69 is 2069, 70 is 1970.
    expect(parseRobotsDate("Thursday, 01-Jan-70 00:00:00 GMT")!.at).toBe(0);
    expect(parseRobotsDate("01 Jan 69 00:00:00 GMT")!.at).toBe(utc("2069-01-01T00:00:00Z"));
  });

  it("refuses anything else rather than guess", () => {
    for (const raw of [
      "June 25, 2010",
      "June 25",
      "25 Jun 2010",
      "25 Jun 2010 15:00:00",
      "25 Jun 2010 15:00:00 CEST",
      "2010-02-30",
      "2010-06-25T24:00:00Z",
      "2010-06-25T15:00:00+2",
      "2010/06/25",
      "Fri, 31 Jun 2010 15:00:00 GMT",
      "Fry, 25 Jun 2010 15:00:00 GMT",
      "1277478000",
      "soon",
      "",
    ]) {
      expect(parseRobotsDate(raw), raw).toBeNull();
    }
  });
});

describe("unavailable_after ends where its date ends (PR #22 re-review M1)", () => {
  it("tokenises a directive written after the date with only a space between", () => {
    expect(robotsTokens("unavailable_after: 25 Jun 2010 15:00:00 PST nofollow")).toEqual([
      "unavailable_after: 25 jun 2010 15:00:00 pst",
      "nofollow",
    ]);
    expect(unavailableAfterOf("unavailable_after: 25 Jun 2010 15:00:00 PST nofollow")).toBe(
      "25 Jun 2010 15:00:00 PST",
    );
  });

  it("ends a date-only value at the date", () => {
    expect(robotsTokens("unavailable_after: 2025-01-01 noindex")).toEqual([
      "unavailable_after: 2025-01-01",
      "noindex",
    ]);
    expect(unavailableAfterOf("unavailable_after: 2025-01-01 noindex")).toBe("2025-01-01");
  });

  it("keeps the longest prefix that is a date, so a whole date is never cut short", () => {
    // "2025-01-01" alone parses too; the date-time is the longer one.
    expect(unavailableAfterOf("unavailable_after: 2025-01-01T10:00:00Z")).toBe(
      "2025-01-01T10:00:00Z",
    );
    expect(robotsTokens("noindex, unavailable_after: Fri, 25 Jun 2010 15:00:00 GMT")).toEqual([
      "noindex",
      "unavailable_after: fri, 25 jun 2010 15:00:00 gmt",
    ]);
  });

  it("keeps the whole value when no prefix of it is a date", () => {
    expect(robotsTokens("unavailable_after: next tuesday nofollow, noarchive")).toEqual([
      "unavailable_after: next tuesday nofollow",
      "noarchive",
    ]);
    expect(unavailableAfterOf("unavailable_after: next tuesday nofollow")).toBe(
      "next tuesday nofollow",
    );
  });
});

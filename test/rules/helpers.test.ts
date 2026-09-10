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
  indexabilityOf,
  isCanonicalisedElsewhere,
  metricRow,
  metricRule,
  present,
  queryFinding,
  resolveEffectiveCanonical,
  type MetricIdentity,
} from "../../src/rules/helpers.js";
import { FETCH_CLASSES } from "../../src/crawl/fetch-page.js";
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

  it("reads a block off the wire status and never calls it a robots.txt block", () => {
    // A block is the site refusing THIS CLIENT — a cf-mitigated header, a
    // 401/403/429, a challenge body on a 503. robots.txt said nothing, and we
    // did get an answer, so it is neither of those two statuses.
    expect(indexabilityOf(notOk("blocked", { statusCode: 403 })).status).toBe("Client Error");
    expect(indexabilityOf(notOk("blocked", { statusCode: 429 })).status).toBe("Client Error");
    expect(indexabilityOf(notOk("blocked", { statusCode: 503 })).status).toBe("Server Error");
    // A challenge served with a 200, and a block with no status at all: the
    // refusal is about the client either way.
    expect(indexabilityOf(notOk("blocked", { statusCode: 200 })).status).toBe("Client Error");
    expect(indexabilityOf(notOk("blocked", { statusCode: null })).status).toBe("Client Error");
  });

  it("reads an ok row that is not a 200 as no HTML to judge", () => {
    expect(indexabilityOf(mkPage({ statusCode: 204, isIndexable: false })).status).toBe(
      "Not HTML",
    );
  });

  it("puts noindex ahead of the canonical when a 200 carries both", () => {
    // The spec's precedence, and the only pair that overlaps on a 200: the page
    // is out of the index whatever it hands its signals to.
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

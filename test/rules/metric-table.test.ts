/**
 * THE FOUR SHAPERS, over synthetic rows.
 *
 * `shapeMetricTable` is the one place a metric's stored jsonb becomes a table,
 * and every surface that prints a metric — the JSON route, the MCP tool, the CSV
 * export, the demo — reads it. What is pinned here is the SHAPING and nothing
 * else: the rows are written by hand, in the shapes the fourteen metrics really
 * write (the block at the bottom asserts that claim against the registry's own
 * declarations), so a failure here is a failure of the shaper rather than of a
 * rule's SQL.
 *
 * The declarations under test are the REAL ones wherever the property is about a
 * real metric (`inlinks.extremes`' merged list, `sitemap.structure`'s two-key
 * columns, `url.param-volumes`' summary), because a property proved about an
 * invented declaration is a property of the invention.
 */
import { describe, expect, it } from "vitest";

import { buildRegistry } from "../../src/rules/index.js";
import {
  expandList,
  expandMap,
  metricTableColumns,
  metricTableSummary,
  perScope,
  perScopeMeasure,
  shapeMetricTable,
  type MetricRule,
  type MetricTable,
  type StoredMetricRow,
} from "../../src/rules/registry/registry.js";

const registry = buildRegistry();

/** One metric rule's real declaration, by id. */
function tableOf(id: string): MetricTable {
  const rule = registry.byKind("metric").find((r: MetricRule) => r.id === id);
  if (rule === undefined) throw new Error(`no metric rule '${id}'`);
  return rule.table;
}

const site = (value: unknown): StoredMetricRow => ({ scope: "site", scopeValue: "", value });
const cohort = (scopeValue: string, value: unknown): StoredMetricRow => ({
  scope: "page_type",
  scopeValue,
  value,
});

/** The header as labels, which is what a reader of these tests wants to see. */
const labels = (table: { columns: readonly { label: string }[] }): string[] =>
  table.columns.map((c) => c.label);

describe("perScope", () => {
  const table = perScope("Template", [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
  ]);

  it("heads the first column with the scope label and prints Site on the site row", () => {
    const shaped = shapeMetricTable("x.y", table, [site({ a: 1, b: 2 })]);
    expect(labels(shaped)).toEqual(["Template", "A", "B"]);
    expect(shaped.columns[0]?.key).toBe("scope");
    expect(shaped.rows).toEqual([{ scope: "Site", a: 1, b: 2 }]);
    expect(shaped.summary).toEqual([]);
  });

  // The site row is the total and the others are parts of it, so a reader meets
  // the whole first; the rest are ordered by their own name, which is the same
  // order on two runs over one crawl where an order by size is not.
  it("puts the site row first and the cohorts in scope-value order", () => {
    const shaped = shapeMetricTable("x.y", table, [
      cohort("/products/:slug", { a: 3 }),
      cohort("(untyped)", { a: 4 }),
      site({ a: 1 }),
      cohort("/blog", { a: 5 }),
    ]);
    expect(shaped.rows.map((r) => r["scope"])).toEqual([
      "Site",
      "(untyped)",
      "/blog",
      "/products/:slug",
    ]);
  });

  // `(untyped)` is the cohort of pages the crawler could not type and `(other)`
  // the templates past a rollup cap. Both are real cohorts with real numbers in
  // them, and the table prints the engine's own word for each rather than
  // inventing a second vocabulary a reader would have to learn.
  it("passes (untyped) and (other) through as the cohort names they are", () => {
    const shaped = shapeMetricTable("x.y", table, [cohort("(untyped)", { a: 7 })]);
    expect(shaped.rows[0]).toEqual({ scope: "(untyped)", a: 7, b: null });
  });

  // THE NULL RULE, which every shaper shares: a key the metric did not write on
  // this row is null and prints as an empty cell — never a zero, which is a
  // measurement somebody would quote.
  it("answers null for a key the row does not carry", () => {
    const shaped = shapeMetricTable("x.y", table, [site({ a: 0 })]);
    expect(shaped.rows[0]).toEqual({ scope: "Site", a: 0, b: null });
  });

  it("refuses a column that names an object or a list rather than a cell", () => {
    expect(() => shapeMetricTable("x.y", table, [site({ a: { count: 1 } })])).toThrow(
      /column 'a' names an object/,
    );
    expect(() => shapeMetricTable("x.y", table, [site({ a: [1, 2] })])).toThrow(
      /column 'a' names a list/,
    );
  });

  // `sitemap.structure`, the one table whose two kinds of row spell a column
  // differently: the site row counts the whole set, a document row counts
  // itself. One heading, both keys declared — and the three site-only columns
  // are empty on a document row, which is exactly the null rule above.
  it("reads a two-key column from whichever key the row carries", () => {
    const shaped = shapeMetricTable("sitemap.structure", tableOf("sitemap.structure"), [
      site({ docs: 5, totalUrls: 376, urlCapBreaches: 0, oversizedDocsSkipped: 0, entryCapReached: false }),
      { scope: "sitemap_doc", scopeValue: "https://site/sitemap-1.xml", value: { urls: 5, breaches50k: false } },
    ]);
    expect(labels(shaped)).toEqual([
      "Sitemap",
      "Entries",
      "Over 50,000 Entries",
      "Documents",
      "Documents Dropped For Size",
      "Entry Cap Reached",
    ]);
    expect(shaped.rows).toEqual([
      {
        scope: "Site",
        entries: 376,
        over50kEntries: 0,
        docs: 5,
        oversizedDocsSkipped: 0,
        entryCapReached: false,
      },
      {
        scope: "https://site/sitemap-1.xml",
        entries: 5,
        over50kEntries: false,
        docs: null,
        oversizedDocsSkipped: null,
        entryCapReached: null,
      },
    ]);
  });
});

describe("perScopeMeasure", () => {
  const table = perScopeMeasure(
    "Template",
    [
      { key: "wordCount", label: "Word Count" },
      { key: "textRatio", label: "Text Ratio" },
    ],
    [
      { key: "count", label: "Pages" },
      { key: "median", label: "Median" },
    ],
    [{ key: "atLeast", label: "Floor" }],
  );

  it("writes one row per stored row per measure, with the measure as a cell", () => {
    const shaped = shapeMetricTable("x.y", table, [
      site({ wordCount: { count: 4, median: 800 }, textRatio: { count: 4, median: 0.1 }, atLeast: true }),
      cohort("/blog", { wordCount: { count: 2, median: 300 }, textRatio: { count: 2, median: 0.2 }, atLeast: false }),
    ]);
    expect(labels(shaped)).toEqual(["Template", "Measure", "Pages", "Median", "Floor"]);
    expect(shaped.rows).toEqual([
      { scope: "Site", measure: "Word Count", count: 4, median: 800, atLeast: true },
      { scope: "Site", measure: "Text Ratio", count: 4, median: 0.1, atLeast: true },
      { scope: "/blog", measure: "Word Count", count: 2, median: 300, atLeast: false },
      { scope: "/blog", measure: "Text Ratio", count: 2, median: 0.2, atLeast: false },
    ]);
  });

  // The scope columns are a fact about the COHORT and not about one measure —
  // `page.weight`'s resource counts — so they ride every measure row of that
  // scope. A reader quoting the image median needs the count of unweighed files
  // in front of them, not four rows up.
  it("repeats a scope column on every measure row of its scope", () => {
    const shaped = shapeMetricTable("x.y", table, [site({ wordCount: {}, textRatio: {}, atLeast: true })]);
    expect(shaped.rows.map((r) => r["atLeast"])).toEqual([true, true]);
  });

  // A row of empty cells rather than a missing row: the reader asked for two
  // measures and is told which one has no numbers, instead of counting rows.
  it("writes a row of nulls for a measure the row does not carry", () => {
    const shaped = shapeMetricTable("x.y", table, [site({ wordCount: { count: 4, median: 800 } })]);
    expect(shaped.rows[1]).toEqual({
      scope: "Site",
      measure: "Text Ratio",
      count: null,
      median: null,
      atLeast: null,
    });
  });
});

describe("expandList", () => {
  it("expands one list into rows and the remaining site scalars into the summary", () => {
    const table = tableOf("url.param-volumes");
    const shaped = shapeMetricTable("url.param-volumes", table, [
      site({
        topParams: [
          { name: "_pos", occurrences: 47, isTracking: false },
          { name: "gclid", occurrences: 3, isTracking: true },
        ],
        totalParams: 5,
        trackingParams: 1,
        parameterisedPages: 61,
        parameterisedIndexablePages: 57,
      }),
    ]);
    expect(labels(shaped)).toEqual(["Parameter", "URLs", "Tracking"]);
    expect(shaped.rows).toEqual([
      { name: "_pos", occurrences: 47, isTracking: false },
      { name: "gclid", occurrences: 3, isTracking: true },
    ]);
    expect(shaped.summary).toEqual([
      { key: "totalParams", label: "Parameters Found", value: 5 },
      { key: "trackingParams", label: "Tracking Parameters", value: 1 },
      { key: "parameterisedPages", label: "URLs With Parameters", value: 61 },
      { key: "parameterisedIndexablePages", label: "Indexable URLs With Parameters", value: 57 },
    ]);
  });

  // `inlinks.extremes` writes two lists of the same shape and a reader wants one
  // table, so the shaper merges them and stamps each row with the list it came
  // from. Without that column the two ends would be indistinguishable — and on a
  // site smaller than the cap they name the SAME pages in opposite orders.
  it("merges two lists in declaration order and tags each row with its list", () => {
    const shaped = shapeMetricTable("inlinks.extremes", tableOf("inlinks.extremes"), [
      site({
        top: [{ url: "https://site/", inlinks: 434 }],
        bottom: [{ url: "https://site/orphan", inlinks: 0 }],
      }),
    ]);
    expect(labels(shaped)).toEqual(["List", "Address", "Inlinks"]);
    expect(shaped.rows).toEqual([
      { list: "Most linked", url: "https://site/", inlinks: 434 },
      { list: "Least linked", url: "https://site/orphan", inlinks: 0 },
    ]);
  });

  it("answers an empty table for a crawl with no site row, and for an empty list", () => {
    const table = tableOf("url.param-volumes");
    expect(shapeMetricTable("url.param-volumes", table, [])).toEqual({
      summary: [],
      columns: metricTableColumns(table),
      rows: [],
    });
    const empty = shapeMetricTable("url.param-volumes", table, [site({ topParams: [], totalParams: 0 })]);
    expect(empty.rows).toEqual([]);
    expect(empty.summary.map((s) => s.value)).toEqual([0, null, null, null]);
  });

  // The shaper reads the site row and nothing else, so a row at another scope is
  // data it would drop. Dropping it silently is the failure hard rule 7 names;
  // the refusal says which rows would have gone.
  it("refuses a stored row at a scope it would silently drop", () => {
    expect(() =>
      shapeMetricTable("url.param-volumes", tableOf("url.param-volumes"), [
        site({ topParams: [] }),
        cohort("/blog", { topParams: [] }),
      ]),
    ).toThrow(/would be dropped without a word/);
  });

  it("refuses a field that is not a list", () => {
    expect(() =>
      shapeMetricTable("x.y", expandList("items", [{ key: "n", label: "N" }]), [
        site({ items: { n: 1 } }),
      ]),
    ).toThrow(/not the list expandList expands/);
  });
});

describe("expandMap", () => {
  const table = expandMap("sources", "Destination Template", "Source Template", "Links");

  // THE ORDER IS RESTORED, NOT PRESERVED: the metric ranks its entries by count
  // and `jsonb` does not store an object's key order at all (Postgres keeps keys
  // by length then bytes), so the rows are re-ordered by value descending — the
  // rule's own ordering — with the key as the tiebreak. The literal below is
  // written in the WRONG order deliberately, so preserving it would fail.
  it("writes one row per stored row per entry, ranked by value with the key as tiebreak", () => {
    const shaped = shapeMetricTable("inlinks.sources-by-type", table, [
      cohort("/", { sources: { "/search": 5, "/products/:slug": 194, "/cart": 5 } }),
      cohort("/blog", { sources: { "/": 1 } }),
    ]);
    expect(labels(shaped)).toEqual(["Destination Template", "Source Template", "Links"]);
    expect(shaped.rows).toEqual([
      { scope: "/", key: "/products/:slug", value: 194 },
      { scope: "/", key: "/cart", value: 5 },
      { scope: "/", key: "/search", value: 5 },
      { scope: "/blog", key: "/", value: 1 },
    ]);
  });

  // A target cohort nothing links to is `{sources: {}}` — a row the metric wrote
  // deliberately (see `sourcesByType`). It contributes no table row, and the
  // scope it named is simply absent from the table rather than shown as zero.
  it("contributes no rows for a stored row whose map is empty", () => {
    expect(shapeMetricTable("x.y", table, [cohort("/orphan", { sources: {} })]).rows).toEqual([]);
  });

  it("refuses a field that is not a map of entries", () => {
    expect(() => shapeMetricTable("x.y", table, [cohort("/", { sources: [1, 2] })])).toThrow(
      /not the object of entries/,
    );
  });
});

/**
 * THE DECLARATIONS THEMSELVES, checked for the properties `defineRule` cannot
 * see from one rule: that all fourteen metrics have one, and that the header a
 * client draws from the catalog is the header the shaped table serves.
 *
 * Whether a declared KEY names something a metric actually writes is a question
 * about a run, and test/fixtures/harness.test.ts answers it over a real crawl.
 */
describe("the ruleset's own declarations", () => {
  it("gives every metric rule a table whose columns are the catalog's", () => {
    const metrics = registry.byKind("metric");
    expect(metrics).toHaveLength(14);
    for (const rule of metrics) {
      expect(rule.table, `${rule.id} declares no table`).toBeDefined();
      const shaped = shapeMetricTable(rule.id, rule.table, []);
      expect(shaped.columns, `${rule.id}'s shaped header is not the catalog's`).toEqual(
        metricTableColumns(rule.table),
      );
      expect(metricTableSummary(rule.table).length, `${rule.id}`).toBe(
        rule.table.shape === "expandList" ? rule.table.summary.length : 0,
      );
      expect(shaped.columns.length, `${rule.id} heads nothing`).toBeGreaterThan(0);
    }
  });

  // The distribution columns are one constant read by five metrics, so a reader
  // comparing the inlink table with the click-depth table is comparing columns
  // rather than two spellings of the same statistic.
  it("heads every distribution with the same eight labels, in the same order", () => {
    const distributions = [
      "inlinks.distribution",
      "structure.depth-distribution",
      "structure.click-depth-distribution",
      "content.metrics-by-type",
      "page.weight",
    ];
    const expected = ["Pages", "Min", "P25", "Median", "Mean", "P75", "P95", "Max"];
    for (const id of distributions) {
      const columns = metricTableColumns(tableOf(id)).map((c) => c.label);
      const start = columns.indexOf("Pages");
      expect(columns.slice(start, start + expected.length), id).toEqual(expected);
    }
  });
});

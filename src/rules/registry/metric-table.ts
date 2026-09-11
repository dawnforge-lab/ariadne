/**
 * THE METRIC TABLE: a metric's stored rows as the table a client reads.
 *
 * A finding rule declares `columns` and its findings are printed as a report
 * (Phase 20). A metric rule had no such declaration: it writes a jsonb object of
 * its own shape into `metrics`, and every surface that wanted to SHOW that
 * object — the demo, a CSV, an agent — had to know the shape by hand. The four
 * different shapes the fourteen metrics write (scalars per scope, a nested
 * distribution per measure per scope, a list on the site row, a map per scope)
 * meant four hand-written renderers per surface, which is three more places for
 * a heading to disagree with the number under it.
 *
 * So a metric declares `MetricRule.table`, and THE ROWS ARE SHAPED ONCE, HERE,
 * from the stored rows — never in a UI. The demo, the CSV export and the MCP
 * tool all read `shapeMetricTable`, so a number's heading is the same string
 * wherever it is printed.
 *
 * ## The declaration is DATA, not a function
 *
 * Every shaper is a plain object with a `shape` discriminant, because the
 * catalog serves the declaration (`rules_catalog`'s `table`) so a client can lay
 * out the header before it asks for a row — exactly as it serves a finding
 * rule's `columns`. A declaration holding a closure could not cross the wire.
 * The four constructors below build those objects; the four `shape*` functions
 * below them interpret one each, and `shapeMetricTable` dispatches.
 *
 * ## What a cell may hold
 *
 * `string | number | boolean | null`, and nothing else. Numbers cross the wire
 * as numbers (the demo formats them, the CSV writes them raw), percentages are
 * numbers under a label ending in "(%)", and a key the metric did not write is
 * `null`, which prints as an empty cell. A column whose key resolves to an
 * OBJECT or an ARRAY is a declaration error and throws naming the metric and the
 * key: a `[object Object]` in a client's spreadsheet is the silent failure hard
 * rule 7 forbids, and the fix is a column per leaf or a different shaper.
 */
import type { MetricScope } from "./types.js";

/**
 * One column of a metric's table: the key on a row, and the heading over it.
 *
 * `key` is a dotted path into the value the shaper is reading — and it is also
 * the key the shaped row carries, so a client reads a cell by the same name the
 * header declares.
 *
 * `from` IS THE ONE PLACE THOSE TWO COME APART, and it exists for the case
 * `sitemap.structure` is: a metric whose site row and whose per-document rows
 * spell the same column differently (`totalUrls` over the whole sitemap set,
 * `urls` inside one document). One heading, two stored keys — so the declaration
 * names both, IN ORDER, and the first that the row carries fills the cell. Where
 * `from` is present `key` names nothing in the stored value at all; it is the
 * column's identity on the wire and in the CSV, and the paths are here.
 * Absent — on thirteen of the fourteen tables — the path is the key.
 *
 * It is NOT a fallback in hard rule 7's sense: nothing is guessed and nothing is
 * hidden. A column with no `from` reads one path and prints empty when the row
 * does not carry it; a column with `from` reads exactly the paths written here
 * and prints empty when the row carries none of them. Both are declared.
 */
export interface MetricColumn {
  key: string;
  label: string;
  from?: readonly string[];
}

/** The paths one column reads, in order: its `from`, or its key. */
export function pathsOf(column: MetricColumn): readonly string[] {
  return column.from ?? [column.key];
}

/**
 * A stored `metrics` row, as the shapers read it — the three columns that
 * matter and not the crawl id or the metric id the caller already knows.
 */
export interface StoredMetricRow {
  scope: MetricScope | string;
  scopeValue: string;
  value: unknown;
}

/** Everything a cell may hold. See the module header. */
export type MetricCell = string | number | boolean | null;

/** One summary scalar: the label a client prints, and the value under it. */
export interface MetricSummaryValue extends MetricColumn {
  value: MetricCell;
}

/** A metric's table, shaped: the header, the rows, and the site-level scalars. */
export interface ShapedMetricTable {
  summary: MetricSummaryValue[];
  columns: MetricColumn[];
  rows: Record<string, MetricCell>[];
}

/**
 * THE KEY OF THE SCOPE COLUMN, on every table whose rows are per stored row.
 *
 * Fixed rather than declared, because it is not a key of any metric's `value`:
 * it is the row's own identity — the template, the sitemap document, or the site
 * — and a metric that wrote a `scope` key of its own would be writing under the
 * name this surface has already taken. `defineRule` refuses a column that
 * declares it.
 */
export const SCOPE_KEY = "scope";

/** What the scope column holds on the row for the crawl as a whole. */
export const SITE_SCOPE_VALUE = "Site";

/** The key of the measure column on a `perScopeMeasure` table. */
export const MEASURE_KEY = "measure";

/**
 * The heading over that column, on both tables that have one
 * (`content.metrics-by-type` and `page.weight`). One constant because it is one
 * word in one register, and two spellings of it would be two columns to a
 * reader comparing the tables.
 */
export const MEASURE_LABEL = "Measure";

/** The keys an `expandMap` row carries: one map entry, as key and value. */
export const MAP_KEY = "key";
export const MAP_VALUE_KEY = "value";

/** The reserved keys no declared column may take. See `SCOPE_KEY`. */
export const RESERVED_TABLE_KEYS: ReadonlySet<string> = new Set([SCOPE_KEY, MEASURE_KEY]);

/**
 * WHERE THIS METRIC SITS IN THE METRIC SECTION, and the only thing on a
 * declaration that is about the SET of tables rather than about this one.
 *
 * The catalog's own order is severity then id, which for the metrics — all of
 * them `info` — is alphabetical, and alphabetical puts `site.health` tenth. That
 * table is the one a reader meets the site through: the census every other table
 * is a part of. So the display order is DECLARED rather than derived, here,
 * beside the columns, because it is the same kind of statement as a label — a
 * decision about what a client reads and in what order — and a consumer that
 * lays the section out itself gets it from `rules_catalog` (`table.order`)
 * rather than re-deriving a list Ariadne already has.
 *
 * Lower first, ties broken by rule id, and a table that declares no order sorts
 * after every table that does. `defineRule` refuses anything but a non-negative
 * integer. It orders the METRIC rules among themselves and nothing else: the
 * rules that find keep the severity-then-id order every surface returns them in.
 */
interface MetricTableCommon {
  /** Display order within the metric section; lower first, ties by rule id. */
  order?: number;
}

/**
 * One row per stored row: the scope, then a column per dotted path into `value`.
 *
 * `scopeLabel` is the heading over the first column and is a property of what
 * the metric's rows ARE — `Template` where they are page types, `Sitemap` where
 * they are sitemap documents, `Scope` where the only row is the site's. The site
 * row prints `Site` in that column whatever the heading says.
 */
export interface PerScopeTable extends MetricTableCommon {
  shape: "perScope";
  scopeLabel: string;
  columns: readonly MetricColumn[];
}

/**
 * One row per stored row × MEASURE: the shape for a metric that writes the same
 * statistics several times over, once per thing measured
 * (`content.metrics-by-type`'s three word counts, `page.weight`'s five byte
 * counts). The measure is a column, its cell is the measure's label, and the
 * columns after it are paths INSIDE that measure's object.
 *
 * `scopeColumns` are paths into the stored `value` itself — a fact about the
 * scope rather than about one measure (`page.weight`'s resource counts) — and
 * are repeated on every measure row of that scope. They are a separate list
 * rather than a path convention because "is this key inside the measure or
 * beside it" must be stated by the declaration and never guessed from whether a
 * lookup happened to miss (hard rule 7).
 */
export interface PerScopeMeasureTable extends MetricTableCommon {
  shape: "perScopeMeasure";
  scopeLabel: string;
  measures: readonly MetricColumn[];
  columns: readonly MetricColumn[];
  scopeColumns: readonly MetricColumn[];
}

/** One list on the site row, and the literal each of its elements is stamped with. */
export interface MetricListSource {
  /** The key of the list on the site row's `value`. */
  field: string;
  /**
   * A column key and the value written into it for every element of THIS list —
   * what tells two merged lists apart (`inlinks.extremes`' `Most linked` and
   * `Least linked`). Required when a table merges more than one list, because
   * without it the rows of the second are indistinguishable from the first's.
   */
  tag?: { key: string; value: string };
}

/**
 * Rows are the ELEMENTS of a list the site row carries; the remaining site
 * scalars become the summary above the table.
 *
 * The columns are paths into an element, not into `value`. More than one list
 * may be merged into one table (`inlinks.extremes` prints its two ends as one
 * list with a `List` column), in declaration order, each tagged.
 */
export interface ExpandListTable extends MetricTableCommon {
  shape: "expandList";
  lists: readonly MetricListSource[];
  columns: readonly MetricColumn[];
  summary: readonly MetricColumn[];
}

/**
 * One row per stored row × MAP ENTRY: the shape for a metric whose value is an
 * open-ended map whose keys are data (`inlinks.sources-by-type`, whose keys are
 * the site's own templates). A column per key is impossible — the keys differ
 * per crawl — so the entry itself is two columns.
 */
export interface ExpandMapTable extends MetricTableCommon {
  shape: "expandMap";
  field: string;
  scopeLabel: string;
  keyLabel: string;
  valueLabel: string;
}

export type MetricTable =
  | PerScopeTable
  | PerScopeMeasureTable
  | ExpandListTable
  | ExpandMapTable;

// ------------------------------------------------------------- constructors

/**
 * `perScope(scopeLabel, columns, order?)` — see `PerScopeTable`.
 *
 * `order` is the trailing argument of all four constructors and means the same
 * thing in each: where this table sits in the metric section (`MetricTableCommon`).
 */
export function perScope(
  scopeLabel: string,
  columns: readonly MetricColumn[],
  order?: number,
): PerScopeTable {
  return { shape: "perScope", scopeLabel, columns, ...orderOf(order) };
}

/** `perScopeMeasure(scopeLabel, measures, columns, scopeColumns?, order?)` — see the type. */
export function perScopeMeasure(
  scopeLabel: string,
  measures: readonly MetricColumn[],
  columns: readonly MetricColumn[],
  scopeColumns: readonly MetricColumn[] = [],
  order?: number,
): PerScopeMeasureTable {
  return {
    shape: "perScopeMeasure",
    scopeLabel,
    measures,
    columns,
    scopeColumns,
    ...orderOf(order),
  };
}

/**
 * `order`, spread rather than assigned, so a declaration that states none has no
 * `order` KEY at all — the `marker` discipline the catalog already follows. A
 * stored `order: undefined` would put the field on every table the catalog
 * serves and make "did this metric declare a position" a truthiness question.
 */
function orderOf(order?: number): { order?: number } {
  return order === undefined ? {} : { order };
}

/**
 * `expandList(field | [sources], columns, summary?)` — see `ExpandListTable`.
 *
 * The first argument is a bare field name for the ordinary case (one list) and a
 * list of sources for the merged one; there is one shaper either way, because
 * merging two lists changes nothing about how a row is built.
 */
export function expandList(
  lists: string | readonly MetricListSource[],
  columns: readonly MetricColumn[],
  summary: readonly MetricColumn[] = [],
  order?: number,
): ExpandListTable {
  return {
    shape: "expandList",
    lists: typeof lists === "string" ? [{ field: lists }] : lists,
    columns,
    summary,
    ...orderOf(order),
  };
}

/** `expandMap(field, scopeLabel, keyLabel, valueLabel, order?)` — see `ExpandMapTable`. */
export function expandMap(
  field: string,
  scopeLabel: string,
  keyLabel: string,
  valueLabel: string,
  order?: number,
): ExpandMapTable {
  return { shape: "expandMap", field, scopeLabel, keyLabel, valueLabel, ...orderOf(order) };
}

// ----------------------------------------------------------------- shaping

/**
 * The header a declaration promises, without a single stored row.
 *
 * `rules_catalog` serves this so a client can draw the table before it asks for
 * the rows, and `shapeMetricTable` returns the SAME list beside them — one
 * function, so a header drawn from the catalog and one drawn from the table
 * cannot disagree.
 */
export function metricTableColumns(table: MetricTable): MetricColumn[] {
  switch (table.shape) {
    case "perScope":
      return [{ key: SCOPE_KEY, label: table.scopeLabel }, ...table.columns];
    case "perScopeMeasure":
      return [
        { key: SCOPE_KEY, label: table.scopeLabel },
        { key: MEASURE_KEY, label: MEASURE_LABEL },
        ...table.columns,
        ...table.scopeColumns,
      ];
    case "expandList":
      return [...table.columns];
    case "expandMap":
      return [
        { key: SCOPE_KEY, label: table.scopeLabel },
        { key: MAP_KEY, label: table.keyLabel },
        { key: MAP_VALUE_KEY, label: table.valueLabel },
      ];
  }
}

/** The summary labels a declaration promises. Only `expandList` has any. */
export function metricTableSummary(table: MetricTable): MetricColumn[] {
  return table.shape === "expandList" ? [...table.summary] : [];
}

/**
 * Where a declaration sits when the metric tables are sorted — its own `order`,
 * or, for one that declares none, after every table that does.
 *
 * A number rather than a nullable, because the caller is a comparator and a
 * comparator that has to branch on absence is a comparator with two orders in
 * it. The sentinel is stated here, once, beside the field it stands in for.
 */
export const METRIC_TABLE_ORDER_LAST = Number.MAX_SAFE_INTEGER;

/** See `METRIC_TABLE_ORDER_LAST`. Ties are broken by the rule id, by the caller. */
export function metricTableOrder(table: MetricTable): number {
  return table.order ?? METRIC_TABLE_ORDER_LAST;
}

/**
 * A metric's stored rows as its table.
 *
 * `metricId` is carried only so a refusal can name the metric: a column pointing
 * at an object, a list field that is not a list, a stored row at a scope the
 * shaper cannot place. Every one of those is a defect in a DECLARATION, and a
 * message that names the metric and the key is the difference between a
 * one-line fix and a hunt.
 */
export function shapeMetricTable(
  metricId: string,
  table: MetricTable,
  rows: readonly StoredMetricRow[],
): ShapedMetricTable {
  const ordered = orderRows(rows);
  switch (table.shape) {
    case "perScope":
      return shapePerScope(metricId, table, ordered);
    case "perScopeMeasure":
      return shapePerScopeMeasure(metricId, table, ordered);
    case "expandList":
      return shapeExpandList(metricId, table, ordered);
    case "expandMap":
      return shapeExpandMap(metricId, table, ordered);
  }
}

/**
 * SITE FIRST, then the rest by scope value.
 *
 * The site row is the total and every other row is a part of it, so a reader
 * meets the whole before the pieces. The rest are ordered by their own name
 * rather than by size, because the order has to be the same on two runs over one
 * crawl and a tie in a count is not (the deterministic-cap lesson). Code-unit
 * order, not a locale's: a locale comparison would order one machine's export
 * differently from another's.
 */
function orderRows(rows: readonly StoredMetricRow[]): StoredMetricRow[] {
  return [...rows].sort((a, b) => {
    if (a.scope === "site" && b.scope !== "site") return -1;
    if (b.scope === "site" && a.scope !== "site") return 1;
    if (a.scopeValue === b.scopeValue) return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0;
    return a.scopeValue < b.scopeValue ? -1 : 1;
  });
}

/** What a row's scope column holds: `Site`, or the cohort's own name verbatim. */
function scopeCell(row: StoredMetricRow): string {
  // `(untyped)` and `(other)` are cohort names like any other and print as they
  // are: they are what the engine calls the pages it could not type and the
  // templates past the source cap, and translating them here would invent a
  // second vocabulary for a value the rest of the surface spells this way.
  return row.scope === "site" ? SITE_SCOPE_VALUE : row.scopeValue;
}

/** One stored row's `value` as an object, or a refusal naming the metric. */
function valueOf(metricId: string, row: StoredMetricRow): Record<string, unknown> {
  const value = row.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${metricId}: the stored row for scope '${row.scope}/${row.scopeValue}' holds ` +
        `${Array.isArray(value) ? "an array" : String(value === null ? "null" : typeof value)}, ` +
        "not the object a metric writes",
    );
  }
  return value as Record<string, unknown>;
}

/**
 * A dotted path into a value, as a cell.
 *
 * ABSENT IS NULL and that is the whole rule: a key the metric did not write on
 * this row prints as an empty cell (`sitemap.structure`'s site-only columns on a
 * document row). A key whose value is an object or an array is NOT absent — it
 * is a column pointing at the wrong thing — and it throws.
 */
export function cellAt(metricId: string, source: unknown, key: string): MetricCell {
  let cursor: unknown = source;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor === "object") {
    throw new Error(
      `${metricId}: column '${key}' names ` +
        `${Array.isArray(cursor) ? "a list" : "an object"}, which has no cell to print — ` +
        "declare a column per value inside it, or use a shaper that expands it",
    );
  }
  if (typeof cursor === "string" || typeof cursor === "number" || typeof cursor === "boolean") {
    return cursor;
  }
  throw new Error(`${metricId}: column '${key}' holds a ${typeof cursor}, which is not a cell`);
}

/**
 * One column's cell: the first of its declared paths the source carries.
 *
 * "Carries" is present-and-not-null. A column with one path is that path's
 * value, null included; a column with several stops at the first that answers,
 * and is null when none of them does — which is the empty cell a row that spells
 * the column another way prints (see `MetricColumn.from`).
 */
function cellOf(metricId: string, source: unknown, column: MetricColumn): MetricCell {
  for (const path of pathsOf(column)) {
    const cell = cellAt(metricId, source, path);
    if (cell !== null) return cell;
  }
  return null;
}

/** `perScope`: one row per stored row. */
export function shapePerScope(
  metricId: string,
  table: PerScopeTable,
  rows: readonly StoredMetricRow[],
): ShapedMetricTable {
  return {
    summary: [],
    columns: metricTableColumns(table),
    rows: rows.map((row) => {
      const value = valueOf(metricId, row);
      const out: Record<string, MetricCell> = { [SCOPE_KEY]: scopeCell(row) };
      for (const column of table.columns) out[column.key] = cellOf(metricId, value, column);
      return out;
    }),
  };
}

/** `perScopeMeasure`: one row per stored row × measure. */
export function shapePerScopeMeasure(
  metricId: string,
  table: PerScopeMeasureTable,
  rows: readonly StoredMetricRow[],
): ShapedMetricTable {
  const out: Record<string, MetricCell>[] = [];
  for (const row of rows) {
    const value = valueOf(metricId, row);
    for (const measure of table.measures) {
      const inside = value[measure.key];
      const cells: Record<string, MetricCell> = {
        [SCOPE_KEY]: scopeCell(row),
        [MEASURE_KEY]: measure.label,
      };
      // A measure the metric did not write on this row is a row of empty cells
      // rather than a missing row: the reader asked for five measures and is
      // told which one has no numbers, instead of counting the rows to notice.
      for (const column of table.columns) {
        cells[column.key] = inside === undefined ? null : cellOf(metricId, inside, column);
      }
      for (const column of table.scopeColumns) {
        cells[column.key] = cellOf(metricId, value, column);
      }
      out.push(cells);
    }
  }
  return { summary: [], columns: metricTableColumns(table), rows: out };
}

/** `expandList`: the site row's list(s) as rows, its remaining scalars as summary. */
export function shapeExpandList(
  metricId: string,
  table: ExpandListTable,
  rows: readonly StoredMetricRow[],
): ShapedMetricTable {
  const site = rows.find((row) => row.scope === "site");
  const others = rows.filter((row) => row.scope !== "site");
  if (others.length > 0) {
    // The shaper reads the SITE row and nothing else, so a row at another scope
    // would be data this table silently drops. A metric that grew a per-cohort
    // row needs a different shaper, and saying so is the point (hard rule 7).
    throw new Error(
      `${metricId}: expandList reads the site row, but this crawl holds ` +
        `${others.length} row(s) at other scopes (${others
          .map((row) => `${row.scope}/${row.scopeValue}`)
          .join(", ")}) — those rows would be dropped without a word`,
    );
  }
  const columns = metricTableColumns(table);
  if (site === undefined) return { summary: [], columns, rows: [] };

  const value = valueOf(metricId, site);
  const out: Record<string, MetricCell>[] = [];
  for (const source of table.lists) {
    const list = value[source.field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new Error(
        `${metricId}: '${source.field}' is a ${typeof list}, not the list expandList expands`,
      );
    }
    for (const element of list) {
      const cells: Record<string, MetricCell> = {};
      for (const column of table.columns) cells[column.key] = cellOf(metricId, element, column);
      // The tag LAST, so a list whose elements carry a key of the tag's name
      // cannot overwrite the thing that says which list this row came from.
      if (source.tag !== undefined) cells[source.tag.key] = source.tag.value;
      out.push(cells);
    }
  }
  return {
    summary: table.summary.map((column) => ({
      ...column,
      value: cellOf(metricId, value, column),
    })),
    columns,
    rows: out,
  };
}

/** `expandMap`: one row per stored row × entry of the declared map. */
export function shapeExpandMap(
  metricId: string,
  table: ExpandMapTable,
  rows: readonly StoredMetricRow[],
): ShapedMetricTable {
  const out: Record<string, MetricCell>[] = [];
  for (const row of rows) {
    const value = valueOf(metricId, row);
    const map = value[table.field];
    if (map === undefined) continue;
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      throw new Error(
        `${metricId}: '${table.field}' on scope '${row.scope}/${row.scopeValue}' is not the ` +
          "object of entries expandMap expands",
      );
    }
    // ORDERED HERE, BECAUSE JSONB THREW THE METRIC'S ORDER AWAY. The rollup
    // that writes this map ranks its entries by count descending
    // (`sourcesByType`) — and a `jsonb` column does not store an object's key
    // order at all: Postgres keeps keys sorted by length and then by bytes, so
    // the ranked list comes back with the shortest template name first. Reading
    // `Object.entries` as written would therefore put an arbitrary row at the
    // top of a table whose whole point is which template sends the most links.
    // The order is restored instead: value descending, then key ascending,
    // which is the rule's own `order by inlinks desc, source_type asc` and is
    // total (a non-numeric value sorts after every number, by key).
    const entries = Object.entries(map as Record<string, unknown>).map(([key, entry]) => ({
      key,
      cell: cellAt(metricId, { [key]: entry }, key),
    }));
    entries.sort((a, b) => {
      const left = typeof a.cell === "number" ? a.cell : null;
      const right = typeof b.cell === "number" ? b.cell : null;
      if (left !== null && right !== null && left !== right) return right - left;
      if ((left === null) !== (right === null)) return left === null ? 1 : -1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    for (const entry of entries) {
      out.push({
        [SCOPE_KEY]: scopeCell(row),
        [MAP_KEY]: entry.key,
        [MAP_VALUE_KEY]: entry.cell,
      });
    }
  }
  return { summary: [], columns: metricTableColumns(table), rows: out };
}

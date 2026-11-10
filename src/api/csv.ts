/**
 * The CSV surface: one writer, two evidence renderings, eight views.
 *
 * These are the files a dashboard's "Bulk export" block hands a human. They are
 * NOT a second API — every view here is a keyset-cursored read of tables the
 * JSON surfaces already answer from, shaped into the flat rectangle a
 * spreadsheet can open. The service streams them; this file decides what a row
 * is and how a string becomes a cell.
 *
 * ## Three properties, and none of them is optional
 *
 * **A cell can never become a formula.** The strings in these files are the
 * crawled site's own text: page titles, anchor texts, evidence a rule quoted
 * off the page. All of it is attacker-controlled — a title is whatever the site
 * put in its `<title>` — and the file opens in Excel on a client's desk. A cell
 * whose first character is `=`, `+`, `-` or `@` is a formula to every
 * spreadsheet ever written, so every such cell is prefixed with an apostrophe
 * BEFORE it is quoted. The guard is uniform, deliberately: applying it only to
 * "text" columns would mean the guard has an inventory to keep up to date, and
 * the day a column moves from number to text is the day the inventory is wrong.
 * A negative number therefore comes out as `'-3`, which is a cell reading -3
 * and not a subtraction, and that is the trade this file makes on purpose.
 *
 * **The quoting is RFC 4180.** Comma, quote, CR or LF anywhere in a cell means
 * the cell is wrapped in quotes and its own quotes are doubled; records end
 * CRLF; the header row is always written, even for a view with no rows —
 * because a zero-row CSV with no header is a file that says nothing about what
 * it failed to contain.
 *
 * **No byte-order mark**, and since the paragraph above justifies this file by
 * the Excel desk, the trade is stated rather than left silent. A UTF-8 BOM is
 * what makes double-clicking a CSV in a pre-2016 Excel on a non-UTF-8 Windows
 * locale render `é` rather than `Ã©`; without one those versions read the file
 * in the system codepage. Against that: a BOM is not part of RFC 4180 and
 * strict parsers hand it to the caller as three bytes glued to the first header
 * cell, so `pandas.read_csv` without `encoding="utf-8-sig"`, a `csv.DictReader`
 * and every `cut -d,` in a pipeline see a first column that is not called
 * `ruleId`. These files are read by pipelines and by a proxying dashboard at
 * least as often as they are double-clicked, the HTTP transport states
 * `charset=utf-8` on the wire where a browser and Talos both honour it, and
 * modern Excel detects UTF-8 unaided. So: no BOM, and a client on an old Excel
 * imports rather than double-clicks. Revisit this the day a real client's file
 * comes back mangled, not before.
 *
 * **Every view is a keyset cursor.** Hard rule 3: the links table is never
 * loaded into memory, and `anchor_texts` is 35,145 rows on the reference crawl.
 * Each view builds a bounded, ordered query whose predicate compares against
 * the last row of the previous batch; the service reads a batch, writes it, and
 * lets it go. Nothing in this file accumulates rows, and `test/api/csv.test.ts`
 * asserts the LIMIT and the comparison against the SQL each view actually
 * builds rather than against this paragraph.
 *
 * ## What a null means in a cell
 *
 * An empty cell is "the engine has no value here", never zero and never false.
 * `indexable` empty is a page whose indexability was never determined (it was
 * not fetched as HTML); `status` empty is a page with no status code;
 * `clickDepth` empty is a page no internal link path reaches; `target` empty on
 * a redirect row is a destination this engine does not know (see
 * `redirects`). Inside the flattened evidence column the same distinction is
 * spelled `key=null`, because there `key=` would be indistinguishable from an
 * empty string the rule actually recorded.
 */
import { sql, type SQL } from "drizzle-orm";

import { indexabilityOf } from "../rules/helpers.js";
import { MAX_REDIRECT_HOPS } from "../rules/query/redirects.js";
import type { IssueType, Priority } from "../rules/registry/types.js";
import { notDisabled } from "./judgement-view.js";

/** The datasets `export_crawl`'s CSV half can write, and the `view` vocabulary. */
export const CSV_VIEWS = [
  "issues",
  "issue_urls",
  "internal_urls",
  "links_to_4xx",
  "links_to_5xx",
  "anchor_texts",
  "redirects",
  "resources",
  "metric_table",
  "issues_overview",
  "crawl_overview",
] as const;
export type CsvViewName = (typeof CSV_VIEWS)[number];

/** The views that are not a keyset read of a table (see `CSV_QUERY_VIEWS`). */
type NonKeysetView = "metric_table" | "issues_overview" | "crawl_overview";

/**
 * THE EIGHT VIEWS THAT ARE A KEYSET READ OF A TABLE — every view but three.
 *
 * `metric_table`, `issues_overview` and `crawl_overview` are the exceptions and
 * they are a different KIND of view. `issues_overview` is one `GROUP BY rule_id`
 * aggregate (one row per rule, at most 175, ordered by type, priority, count),
 * built by `buildIssuesOverview` — the same function the JSON tool calls, so the
 * two cannot disagree — and an aggregate has no keyset. `crawl_overview` is the
 * same kind: a fixed set of sectioned aggregates (`buildCrawlOverview`, shared
 * with the `crawl_overview` tool), bounded by its sections and their
 * vocabularies, never by the site. `metric_table`'s rows
 * are not rows of a table at all. One metric's stored rows become a table
 * through the rule's own `table` declaration (`shapeMetricTable`), which turns
 * one stored row into three (a measure each), or a stored list into twenty rows,
 * or a stored map into its entries — a transformation no `ORDER BY … LIMIT` can
 * express. So it has no `CsvView` definition, and the properties that make the
 * other eight safe on a 50,000-page crawl (a LIMIT, an order, a cursor
 * comparison) are asserted over THIS list rather than over the vocabulary.
 *
 * What bounds `metric_table` instead is the rows themselves: one metric writes
 * one row per cohort — a page type, a sitemap document, the site — and the
 * shaper's expansion of each is bounded by the metric's own caps
 * (`EXTREMES_LIST_CAP`, `SOURCE_TYPE_CAP`, `TOP_PARAMS_CAP`). See
 * `ApiService.metricTable`, which is the one place those rows are read.
 */
export const CSV_QUERY_VIEWS = CSV_VIEWS.filter(
  (view): view is Exclude<CsvViewName, NonKeysetView> =>
    view !== "metric_table" && view !== "issues_overview" && view !== "crawl_overview",
);
export type CsvQueryViewName = (typeof CSV_QUERY_VIEWS)[number];

/** The two spellings `format` takes. The first is the default and the original. */
export const EXPORT_FORMATS = ["jsonl.gz", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The list separator INSIDE a cell — check ids, a redirect chain, an array in
 * the evidence.
 *
 * A pipe rather than a comma, and one separator for all three rather than a
 * prettier one per column: a comma would be legal (the cell would simply be
 * quoted) and would make every list unsplittable by the person who opens the
 * file and reaches for "Text to Columns". One character, documented once.
 */
const LIST_SEPARATOR = "|";

/** The four characters a spreadsheet reads as "this cell is a formula". */
const FORMULA_LEADERS = ["=", "+", "-", "@"];

/**
 * One cell: the injection guard, then RFC 4180 quoting.
 *
 * The order is the whole point and is tested. Quoting first and guarding after
 * would inspect a `"` and find no formula leader behind it.
 *
 * ## The leader is looked for PAST any leading whitespace
 *
 * A leading space is not a defence, it is camouflage: several readers —
 * LibreOffice's CSV import among them — strip whitespace from an unquoted field
 * and then evaluate what was behind it, so `" =SUM(1+1)"` is the same attack
 * with one character in front of it. The decision is therefore made on the
 * trimmed value while the ORIGINAL is what gets written, because the cell is
 * evidence and this file does not edit a site's own text.
 *
 * Doing it here rather than relying on the values being trimmed already is
 * deliberate. The page analyzer does collapse and trim a title today, so the
 * variant is unreachable through that column as things stand — which is exactly
 * the kind of guarantee that belongs to another module, has no test pointing at
 * this one, and changes without anybody thinking about spreadsheets. The guard
 * holds on its own.
 */
export function csvCell(value: string): string {
  const leader = value.replace(/^\s+/, "").slice(0, 1);
  const guarded = FORMULA_LEADERS.includes(leader) ? `'${value}` : value;
  return /["\r\n,]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** One record, CRLF-terminated. A record is one yield of the streaming export. */
export function csvRecord(cells: readonly string[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** Leaves shown in one evidence cell before the rest are counted instead. */
export const EVIDENCE_MAX_LEAVES = 12;
/** Characters of one leaf's value before it is clipped with an ellipsis. */
export const EVIDENCE_MAX_VALUE = 120;
/** Characters of a whole evidence cell. Leaves are dropped, never cut mid-leaf. */
export const EVIDENCE_MAX_CELL = 500;

/**
 * A finding's evidence as ONE deterministic cell.
 *
 * A rule's `details_jsonb` is a nested object of the rule's own design, and a
 * spreadsheet has one cell for it. Dumping the JSON in would be a cell nobody
 * can read, filter or sort — and it would put a `{`-shaped blob in a column
 * whose neighbours are values. So the object is flattened to `path=value`
 * leaves, joined with `; `:
 *
 *  - object keys are SORTED at every level and array elements keep their index
 *    order, so the same evidence always produces the same cell — a diff between
 *    two exports is a change in the findings, never a change in key order;
 *  - paths are dotted, array elements indexed: `truncated.total`,
 *    `sources[0].url`;
 *  - `pageUrl` is dropped, because it is the row's own `url` column;
 *  - a scalar array collapses to `a|b|c` rather than three indexed leaves —
 *    a redirect chain is one fact;
 *  - `null`, `[]` and `{}` are SPELLED. A rule that recorded "no final status"
 *    said something, and an empty cell would be a different claim;
 *  - whitespace inside a value is collapsed, so one finding is always one row
 *    even when the quoted text contained newlines;
 *  - a value longer than `EVIDENCE_MAX_VALUE` is clipped with `…`, and leaves
 *    past `EVIDENCE_MAX_LEAVES` (or past `EVIDENCE_MAX_CELL` characters) are
 *    replaced by `+N more`. The full evidence is always available on
 *    issues_list / issue_urls; the CSV is a summary and says when it is one.
 */
export function flattenEvidence(evidence: Record<string, unknown>): string {
  const leaves: string[] = [];
  walk(evidence, "", leaves);
  const shown: string[] = [];
  let length = 0;
  for (const leaf of leaves) {
    if (shown.length >= EVIDENCE_MAX_LEAVES) break;
    const next = length === 0 ? leaf.length : length + 2 + leaf.length;
    if (shown.length > 0 && next > EVIDENCE_MAX_CELL) break;
    shown.push(leaf);
    length = next;
  }
  // THE MARKER COUNTS TOWARDS THE CAP. Appending it after the loop is how the
  // bound got broken once already: a cell that stopped at 498 characters came
  // back 507 long. Leaves are dropped until the whole cell — marker included —
  // fits, and one leaf always survives so the cell is never only a count.
  for (;;) {
    const dropped = leaves.length - shown.length;
    const cell = dropped > 0 ? [...shown, `+${dropped} more`].join("; ") : shown.join("; ");
    if (cell.length <= EVIDENCE_MAX_CELL || shown.length <= 1) return cell;
    shown.pop();
  }
}

/**
 * The depth-first walk `flattenEvidence` is: sorted keys, indexed elements.
 *
 * `dropPageUrl` is false for `boundedLeaves`, which walks ONE COLUMN's value
 * rather than a whole evidence blob. The filter exists because the blob's
 * top-level `pageUrl` is the row's own `url` column; a `pageUrl` key inside a
 * column's object would be a different fact, and dropping it because it sits at
 * depth zero of that value would delete evidence for a coincidence of nesting.
 *
 * `listSeparator` is the caller's, for the same reason `evidenceCell` and
 * `flattenEvidence` disagree about it at the top level: the flattened
 * `evidence` column of the older views is a cell somebody splits back out (a
 * pipe survives "Text to Columns"), and a report cell under its own heading is
 * a cell somebody READS (a comma is what English uses). A nested scalar array
 * is the same value either way, so it takes the separator of the view it is
 * being printed into — and the demo's `leaves` (src/demo/index.html), which is
 * this function in the page, joins with the comma because the only view it
 * renders is `issue_urls`.
 */
function walk(
  value: unknown,
  path: string,
  out: string[],
  dropPageUrl = true,
  listSeparator: string = LIST_SEPARATOR,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${path}=[]`);
      return;
    }
    if (value.every((item) => item === null || typeof item !== "object")) {
      out.push(`${path}=${value.map(scalar).join(listSeparator)}`);
      return;
    }
    value.forEach((item, index) =>
      walk(item, `${path}[${index}]`, out, dropPageUrl, listSeparator),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !(dropPageUrl && path === "" && key === "pageUrl"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) {
      // The top level is not a leaf: evidence holding nothing but a pageUrl is
      // an empty cell, not a `{}`.
      if (path !== "") out.push(`${path}={}`);
      return;
    }
    for (const [key, child] of entries)
      walk(child, path === "" ? key : `${path}.${key}`, out, dropPageUrl, listSeparator);
    return;
  }
  out.push(`${path}=${scalar(value)}`);
}

/** One leaf value: whitespace collapsed, length bounded, null spelled. */
function scalar(value: unknown): string {
  const text =
    value === null || value === undefined
      ? "null"
      : typeof value === "string"
        ? value.replace(/\s+/g, " ").trim()
        : String(value);
  return text.length > EVIDENCE_MAX_VALUE ? `${text.slice(0, EVIDENCE_MAX_VALUE - 1)}…` : text;
}

/** The rule copy a view joins onto a stored row, exactly as the JSON surfaces do. */
export interface CsvRuleCopy {
  title: string;
  category: string;
  checkIds: readonly string[];
  /** The rule's type and priority after the crawl's overrides (Phase 27a). */
  type: IssueType;
  priority: Priority;
  /**
   * The rule's report, column by column — the four standard columns and then the
   * rule's own (`columnsFor`, src/api/service.ts). The `issue_urls` view's HEADER
   * is these labels and its cells are these keys, so the spreadsheet a client
   * downloads and the table it renders from the JSON listing are the same table.
   *
   * Empty on a view that is not about one rule; only `issue_urls` reads it.
   */
  columns: ReadonlyArray<{ key: string; label: string }>;
}

/**
 * What a view is allowed to ask the service for.
 *
 * Two functions rather than an import, so this file depends on no service:
 * `rule` is the read-time copy join (and its refusal for a row whose rule this
 * ruleset no longer defines), `evidence` is the same check the JSON export
 * makes before it calls a stored blob an object.
 */
export interface CsvViewContext {
  rule(ruleId: string): CsvRuleCopy;
  evidence(value: unknown, ruleId: string): Record<string, unknown>;
}

export interface CsvView {
  /**
   * The header row, always written.
   *
   * A FUNCTION OF THE REQUEST rather than a constant, since Phase 20: the
   * `issue_urls` view's columns are the rule's, so its header cannot be known
   * until the rule is. Every other view still declares a plain array and
   * `defineCsvView` wraps it in a function that ignores both arguments, so only
   * the one view that needs the request sees it.
   */
  header(ruleId: string | null, ctx: CsvViewContext): readonly string[];
  /** The columns the cursor is made of — documentation, and the start's arity. */
  readonly keyset: readonly string[];
  /** A cursor that sorts before every real row. Every view starts here. */
  readonly start: readonly string[];
  /** Whether the view is about one rule and cannot be built without its id. */
  readonly needsRuleId: boolean;
  /**
   * One bounded, ordered batch after `cursor`. `disabledRules` is the crawl's
   * judgement's disabled set: the two findings views leave those rules' stored
   * rows out in SQL (Phase 27a); every other view is not about findings and
   * ignores it.
   */
  query(
    crawlId: string,
    cursor: readonly string[],
    limit: number,
    ruleId: string | null,
    disabledRules: readonly string[],
  ): SQL;
  /** The cursor that follows this row. */
  next(row: Record<string, unknown>): string[];
  /** The row's cells, in header order. */
  cells(row: Record<string, unknown>, ctx: CsvViewContext): string[];
}

/**
 * Define a view with its row type intact inside, erased outside.
 *
 * The registry has to be one homogeneous record for the service to index it by
 * name, and each view's rows are a different shape. The cast happens once, here,
 * against the shape the view's own query selects.
 */
function defineCsvView<Row extends Record<string, unknown>>(view: {
  header: readonly string[] | ((ruleId: string | null, ctx: CsvViewContext) => readonly string[]);
  keyset: readonly string[];
  start: readonly string[];
  needsRuleId?: boolean;
  query(
    crawlId: string,
    cursor: readonly string[],
    limit: number,
    ruleId: string | null,
    disabledRules: readonly string[],
  ): SQL;
  next(row: Row): string[];
  cells(row: Row, ctx: CsvViewContext): string[];
}): CsvView {
  return {
    header:
      typeof view.header === "function" ? view.header : () => view.header as readonly string[],
    keyset: view.keyset,
    start: view.start,
    needsRuleId: view.needsRuleId ?? false,
    query: view.query,
    next: (row) => view.next(row as Row),
    cells: (row, ctx) => view.cells(row as Row, ctx),
  };
}

/** A nullable column as a cell: empty means the engine has no value (see header). */
function orEmpty(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

const ISSUE_HEADER = [
  "ruleId", "severity", "type", "priority", "category", "checkIds", "url", "title", "evidence",
];

/**
 * The header of the always-present last column of `issue_urls`, and the only
 * one that is not a rule's or the surface's: the cap note.
 *
 * Named rather than spelled inline because two places have to agree about it —
 * the header and the cell — and a report whose last column is headed one thing
 * and filled from another is worse than no column.
 */
export const TRUNCATED_LABEL = "Truncated";

/**
 * The list separator INSIDE one report cell.
 *
 * A COMMA, deliberately, where `LIST_SEPARATOR` is a pipe — the two are
 * different jobs and this is the one the design named (spec §2.1: array
 * evidence "is rendered as a comma-joined cell"). `LIST_SEPARATOR` serves a
 * fixed column whose whole value is a list a reader will want to split back out
 * (`checkIds`, a redirect chain in the `redirects` view), and a pipe survives
 * "Text to Columns" where a comma would need the cell unquoted. A report cell
 * is read, not split: `sampleSources` under a heading that says `Sample
 * Sources` is three URLs a person's eye runs down, and a comma is what English
 * uses. RFC 4180 quoting makes the comma safe either way.
 *
 * It reaches `walk` too, so a scalar array NESTED inside a column's object is
 * joined the same way as one at the top of it — one cell, one separator — and
 * the page's `valueText` (src/demo/index.html) prints the identical string.
 */
const CELL_SEPARATOR = ", ";

/** The `pages` columns the standard four report columns are derived from. */
interface IndexabilityRow {
  page_url: string | null;
  status_code: number | null;
  fetch_class: string | null;
  robots_meta: string | null;
  x_robots_tag: string | null;
  is_indexable: boolean | null;
  canonical_html: string | null;
  canonical_header: string | null;
}

/**
 * The four standard columns of one finding row, as cells, keyed by column key.
 *
 * ONE DERIVATION, shared with the JSON listing through `indexabilityOf`: the
 * spreadsheet and the API answer the same three words about a page because they
 * run the same function over the same eight columns.
 *
 * `fetch_class` is `not null` on a `pages` row, so a null here is the left join
 * finding nothing — no page, and three EMPTY cells rather than invented ones.
 * Empty means "the engine has no value", the same as everywhere else in this
 * file, and `address` is still filled: a URL with no page row (a probed host
 * variant, a sitemap URL the frontier never reached) is exactly that case.
 */
function standardCells(row: IssueRow & IndexabilityRow): Record<string, string> {
  const judged =
    row.fetch_class === null
      ? null
      : indexabilityOf({
          url: row.page_url ?? "",
          fetchClass: row.fetch_class,
          statusCode: row.status_code,
          robotsMeta: row.robots_meta,
          xRobotsTag: row.x_robots_tag,
          isIndexable: row.is_indexable,
          canonicalHtml: row.canonical_html,
          canonicalHeader: row.canonical_header,
        });
  return {
    address: orEmpty(row.url),
    statusCode: row.fetch_class === null ? "" : orEmpty(row.status_code),
    indexability: judged === null ? "" : judged.indexability,
    // An INDEXABLE row's status is the empty string by construction
    // (`IndexabilityStatus`), which is the same cell a page with no row gets —
    // and correctly so: both mean "there is no reason to print here". The
    // `Indexability` column beside it is what tells them apart.
    indexabilityStatus: judged === null ? "" : judged.status,
  };
}

/**
 * ONE EVIDENCE VALUE AS ONE CELL — the per-column twin of `flattenEvidence`.
 *
 * Four shapes, and each is the reading a person doing the fix wants:
 *
 *  - a SCALAR is itself, whitespace collapsed and clipped at
 *    `EVIDENCE_MAX_VALUE` (`scalar`, the same one the flattened cell uses);
 *  - `null` and a MISSING key are both an empty cell. They are the same fact
 *    here: this row has no value under this heading. (Inside `flattenEvidence`
 *    they are spelled `key=null`, because there the alternative was a leaf that
 *    looked like an empty string; under a heading of its own an empty cell
 *    already reads as "nothing", which is the file-wide convention.)
 *  - an ARRAY OF SCALARS is its members, comma-joined — `sampleSources` under
 *    `Sample Sources` is the list of pages that link to the broken URL, up to
 *    ten of however many there are, which is why the heading says sample. An
 *    EMPTY array
 *    is an empty cell for the same reason a null is: under a heading, "nothing"
 *    is what a blank says. (`flattenEvidence` spells it `key=[]`, because there
 *    a leaf with no value would have looked like an empty string.)
 *  - anything with an object in it — `closest`, `hosts`, `resources`, the
 *    `truncated` note — is flattened to its `path=value` leaves, sorted and
 *    bounded exactly as `flattenEvidence` bounds a whole blob. It is a
 *    structured fact in a rectangle, and the alternative (raw JSON) is a cell
 *    nobody can read and every spreadsheet mangles.
 */
export function evidenceCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (value.every((item) => item === null || typeof item !== "object")) {
      return value.map(scalar).join(CELL_SEPARATOR);
    }
    return boundedLeaves(value);
  }
  if (typeof value === "object") return boundedLeaves(value);
  return scalar(value);
}

/**
 * A structured value as bounded `path=value` leaves — `flattenEvidence`'s
 * body, applied to one column's value instead of to a whole blob, so one cell
 * of a report cannot grow past the same caps.
 */
function boundedLeaves(value: object): string {
  const leaves: string[] = [];
  // `CELL_SEPARATOR`, not the pipe: this is a report cell, and a scalar array
  // nested inside a column's object is the same list as one at the top of it.
  walk(value, "", leaves, false, CELL_SEPARATOR);
  const shown: string[] = [];
  let length = 0;
  for (const leaf of leaves) {
    if (shown.length >= EVIDENCE_MAX_LEAVES) break;
    const next = length === 0 ? leaf.length : length + 2 + leaf.length;
    if (shown.length > 0 && next > EVIDENCE_MAX_CELL) break;
    shown.push(leaf);
    length = next;
  }
  for (;;) {
    const dropped = leaves.length - shown.length;
    const cell = dropped > 0 ? [...shown, `+${dropped} more`].join("; ") : shown.join("; ");
    if (cell.length <= EVIDENCE_MAX_CELL || shown.length <= 1) return cell;
    shown.pop();
  }
}

interface IssueRow extends Record<string, unknown> {
  rule_id: string;
  severity: string;
  url: string | null;
  evidence: unknown;
  dedupe_key: string;
}

interface LinkRow extends Record<string, unknown> {
  source: string;
  target: string;
  anchor: string | null;
  source_page_id: string;
  position: number;
}

/** The keyset every links-derived view rides: the source index, then the row. */
const LINK_KEYSET = ["source_page_id", "target_url", "position"] as const;
/**
 * `position` is a non-negative index within its page, so -1 sorts before every
 * row. Only the leading part of the comparison actually decides the first
 * batch; this is here so the arity is right and the value is never a real one.
 */
const LINK_START = ["", "", "-1"] as const;

function linkKeyset(crawlId: string, cursor: readonly string[]): SQL {
  return sql`l.crawl_id = ${crawlId}
    and (l.source_page_id, l.target_url, l.position) >
        (${cursor[0] ?? ""}::text, ${cursor[1] ?? ""}::text, ${cursor[2] ?? "-1"}::int)`;
}

/**
 * The two broken-target link worksheets, which differ in exactly one token: the
 * `fetch_class` the target answered with.
 *
 * A factory rather than two spelled-out views, for `linkTargetClassFindings`'
 * reason (src/rules/query/link-targets.ts): the question is one question asked
 * of two status classes, and two copies of it are two places for the keyset,
 * the internal-only join or the column order to drift.
 */
function linkTargetView(fetchClass: "client_error" | "server_error"): CsvView {
  return defineCsvView<LinkRow & { status_code: number | null }>({
    header: ["Source", "Destination", "Anchor", "Status Code"],
    keyset: [...LINK_KEYSET],
    start: [...LINK_START],
    query: (crawlId, cursor, limit) => sql`
      select src.url as source, l.target_url as target, l.anchor,
             tgt.status_code, l.source_page_id, l.position
      from links l
      join pages src on src.crawl_id = ${crawlId} and src.id = l.source_page_id
      join pages tgt on tgt.crawl_id = ${crawlId} and tgt.url = l.target_url
      where ${linkKeyset(crawlId, cursor)}
        and l.is_internal and tgt.fetch_class = ${fetchClass}
      order by l.source_page_id asc, l.target_url asc, l.position asc
      limit ${limit}`,
    next: linkNext,
    cells: (row) => [row.source, row.target, orEmpty(row.anchor), orEmpty(row.status_code)],
  });
}

function linkNext(row: LinkRow): string[] {
  return [row.source_page_id, row.target, String(row.position)];
}

/**
 * The eight views.
 *
 * Every one of them answers a question the Ahrefs-style bulk-export block asks,
 * and every one of them is a read the JSON surface could already answer more
 * slowly, page by page. Nothing here judges.
 */
export const CSV_VIEW_DEFS: Record<CsvQueryViewName, CsvView> = {
  /**
   * Every finding of a judged crawl, one row each — the same rows, in the same
   * order, as the `issues` JSONL dataset, with the evidence flattened. Since
   * Phase 27a the rule's type and priority (after the crawl's overrides) follow
   * the severity, and the findings of a rule the crawl's judgement disables are
   * left out, in SQL.
   */
  issues: defineCsvView<IssueRow>({
    header: ISSUE_HEADER,
    keyset: ["rule_id", "dedupe_key"],
    start: ["", ""],
    query: (crawlId, cursor, limit, _ruleId, disabledRules) => sql`
      select i.rule_id, i.severity,
             i.details_jsonb->>'pageUrl' as url,
             i.details_jsonb as evidence,
             i.dedupe_key
      from issues i
      where i.crawl_id = ${crawlId}
        and ${notDisabled(disabledRules)}
        and (i.rule_id, i.dedupe_key) > (${cursor[0] ?? ""}::text, ${cursor[1] ?? ""}::text)
      order by i.rule_id asc, i.dedupe_key asc
      limit ${limit}`,
    next: (row) => [row.rule_id, row.dedupe_key],
    cells: (row, ctx) => {
      const rule = ctx.rule(row.rule_id);
      return [
        row.rule_id,
        row.severity,
        rule.type,
        rule.priority,
        rule.category,
        rule.checkIds.join(LIST_SEPARATOR),
        orEmpty(row.url),
        rule.title,
        flattenEvidence(ctx.evidence(row.evidence, row.rule_id)),
      ];
    },
  }),

  /**
   * ONE RULE'S FINDINGS AS THE REPORT A CLIENT ACTS ON — the drill-down as a
   * spreadsheet, and since Phase 20 a real table rather than a URL beside a
   * flattened blob.
   *
   * ## The header is the RULE's
   *
   * Every other view in this file has a header it knows at module load. This one
   * cannot: the columns are `columnsFor(rule)` — the four standard ones, then
   * whatever the rule declares — so the header is a function of the rule id the
   * request named, and the cells are read key by key out of the same list. The
   * row a spreadsheet opens is therefore the row the JSON listing serves, drawn
   * from one declaration.
   *
   * ## The last column is always `Truncated`, and it is always there on purpose
   *
   * A rule that stopped listing at its cap writes a `truncated` note into the
   * evidence of its LAST finding, and every JSON surface reads it. In a table
   * the note has nowhere to live but a column — and dropping it would make a
   * capped export a file that says "here is the problem" while holding a
   * fraction of it, with nothing on the page saying so. That is the silent
   * failure hard rule 7 forbids, so the column is written for every rule and is
   * empty on every row but the one that carries the note. The empty column is
   * the price; a complete-looking incomplete export is not.
   */
  issue_urls: defineCsvView<IssueRow & IndexabilityRow>({
    header: (ruleId, ctx) => [
      ...(ruleId === null ? [] : ctx.rule(ruleId).columns.map((column) => column.label)),
      TRUNCATED_LABEL,
    ],
    keyset: ["dedupe_key"],
    start: [""],
    needsRuleId: true,
    // The left join is `listIssueUrls`' — a finding names a page, names a URL
    // with no page row, or names nothing, and an inner join would drop two of
    // those three silently.
    // A disabled rule is refused before this view is built (the service's
    // `refuseIfDisabled`); the clause is the same SQL filter the `issues` view
    // applies, so the view never depends on the caller having checked.
    query: (crawlId, cursor, limit, ruleId, disabledRules) => sql`
      select i.rule_id, i.severity,
             i.details_jsonb->>'pageUrl' as url,
             i.details_jsonb as evidence,
             i.dedupe_key,
             p.url as page_url, p.status_code, p.fetch_class,
             p.robots_meta, p.x_robots_tag, p.is_indexable,
             p.canonical_html, p.canonical_header
      from issues i
      -- The crawl on both sides of the join, not just in the WHERE: see
      -- listIssueUrls (src/api/service.ts) for why.
      left join pages p on p.id = i.page_id and p.crawl_id = ${crawlId}
      where i.crawl_id = ${crawlId} and i.rule_id = ${ruleId ?? ""}
        and ${notDisabled(disabledRules)}
        and i.dedupe_key > ${cursor[0] ?? ""}::text
      order by i.dedupe_key asc
      limit ${limit}`,
    next: (row) => [row.dedupe_key],
    cells: (row, ctx) => {
      const evidence = ctx.evidence(row.evidence, row.rule_id);
      const standard = standardCells(row);
      return [
        ...ctx.rule(row.rule_id).columns.map((column) =>
          column.key in standard
            ? standard[column.key]!
            : evidenceCell(evidence[column.key]),
        ),
        evidenceCell(evidence["truncated"]),
      ];
    },
  }),

  /**
   * Every page the crawl holds a row for. "Internal" is a fact about the crawl
   * rather than a filter: the frontier only ever fetches URLs on the site's own
   * host family, so `pages` is exactly the internal URL list.
   */
  internal_urls: defineCsvView<{
    url: string;
    status_code: number | null;
    fetch_class: string;
    is_indexable: boolean | null;
    click_depth: number | null;
    page_type: string | null;
    title: string | null;
    recheck_fetch_class: string | null;
    recheck_status_code: number | null;
    /**
     * A STRING, not a Date: these views read through `db.execute`, which hands
     * back postgres's own text form (`2026-09-08 14:14:37.642+00`) rather than
     * the Date the query builder's column mappers produce. Typed as what it is,
     * and converted below.
     */
    recheck_at: string | null;
  }>({
    header: [
      "url", "status", "fetchClass", "indexable", "clickDepth", "pageType", "title",
      // THE SECOND OBSERVATION, three columns wide (Phase 17). A list of server
      // errors that cannot be sorted by "still broken" is the wrong list: the
      // 5xx re-verification pass is what separates a confirmed outage from a
      // blip, and a spreadsheet is where that separation is actually used.
      // Empty on every page nobody re-asked about, which is every page whose
      // first fetch was not a `server_error` — never "it was fine".
      "recheckFetchClass", "recheckStatus", "recheckAt",
    ],
    keyset: ["url"],
    start: [""],
    query: (crawlId, cursor, limit) => sql`
      select p.url, p.status_code, p.fetch_class, p.is_indexable,
             p.click_depth, p.page_type, p.title,
             p.recheck_fetch_class, p.recheck_status_code, p.recheck_at
      from pages p
      where p.crawl_id = ${crawlId} and p.url > ${cursor[0] ?? ""}::text
      order by p.url asc
      limit ${limit}`,
    next: (row) => [row.url],
    cells: (row) => [
      row.url,
      orEmpty(row.status_code),
      row.fetch_class,
      orEmpty(row.is_indexable),
      orEmpty(row.click_depth),
      orEmpty(row.page_type),
      orEmpty(row.title),
      orEmpty(row.recheck_fetch_class),
      orEmpty(row.recheck_status_code),
      // ISO 8601, the same spelling every other instant on this surface uses —
      // postgres's own text form is neither ISO nor what a reader comparing this
      // cell with `crawl_status`'s `passAt` would expect. An unparseable value
      // throws here rather than becoming a cell nobody can read.
      row.recheck_at === null ? "" : new Date(row.recheck_at).toISOString(),
    ],
  }),

  /**
   * INTERNAL LINKS WHOSE TARGET ANSWERED 4xx — the broken-link worksheet, one
   * row per LINK rather than per target, because the fix is made in the source
   * page's markup.
   *
   * Internal only, and that is not a filter but the join: an external target is
   * never fetched, so this engine has no status to report for it and will not
   * invent one. The target's class is the crawl's own (`client_error`), which is
   * the same predicate `links.broken-internal` fires on.
   *
   * ITS COLUMNS ARE THE INLINKS REPORT'S (Phase 20): `Source`, `Destination`,
   * `Anchor`, `Status Code` — the same four, in the same order, under the same
   * headings as `GET /crawls/:id/issues/links.broken-internal/inlinks` and as
   * Screaming Frog's own inlinks exports. The old lower-case `source, target,
   * status, anchorText` said the same things in a private vocabulary and in a
   * different order, and a client that has both files open should not have to
   * translate between them.
   */
  links_to_4xx: linkTargetView("client_error"),

  /**
   * The same worksheet for a 5xx target — the twin of the view above, and a
   * separate view for the reason `links.to-server-error` is a separate rule: a
   * 404 is fixed by editing or restoring the URL and a 502 is fixed by reading
   * the server's logs, and one file holding both would be a list nobody can
   * hand to one person.
   */
  links_to_5xx: linkTargetView("server_error"),

  /**
   * Every link the crawl recorded, with the text it was linked by — internal
   * and external alike, because "what do we call this page when we link to it"
   * is a question about both.
   *
   * An empty `text` cell is a link with no anchor text at all (an image link, a
   * bare `<a>`), which is a finding in itself and is why the row is here.
   */
  anchor_texts: defineCsvView<LinkRow>({
    header: ["source", "target", "text"],
    keyset: [...LINK_KEYSET],
    start: [...LINK_START],
    query: (crawlId, cursor, limit) => sql`
      select src.url as source, l.target_url as target, l.anchor,
             l.source_page_id, l.position
      from links l
      join pages src on src.crawl_id = ${crawlId} and src.id = l.source_page_id
      where ${linkKeyset(crawlId, cursor)}
      order by l.source_page_id asc, l.target_url asc, l.position asc
      limit ${limit}`,
    next: linkNext,
    cells: (row) => [row.source, row.target, orEmpty(row.anchor)],
  }),

  /**
   * One row per page that redirects, and the path it puts a visitor on.
   *
   * PER REDIRECTING PAGE, not per chain head: `a -> b -> c` is two rows, one
   * from `a` and one from `b`. That is what makes the file answerable — the
   * person fixing it has a URL in a rewrite rule and wants the row for it — and
   * it is why `hops` is counted from the row's own source.
   *
   * The walk follows `redirect_url_normalised`, which is the spelling
   * `pages.url` is keyed by (a `Location` carrying a fragment names the same
   * page as the row the crawl created from it), and stops at
   * `MAX_REDIRECT_HOPS` or at a URL it has already visited. What the walk could
   * not resolve it says rather than guesses:
   *
   *  - an EMPTY target means the destination is unknown — either the walk hit
   *    the hop limit with the path still going (so `hops` is a floor), or the
   *    page is a 3xx whose `Location` this engine could not use at all;
   *  - a LOOP shows as a chain whose last URL is one that appears earlier in
   *    the same chain, and `target` is that URL: the visitor really does end up
   *    back there;
   *  - the final element of a chain is quoted as the SERVER spelled it when the
   *    walk did not fetch it, and by its frontier key when it did.
   */
  redirects: defineCsvView<{
    source: string;
    chain: string[];
    is_cycle: boolean;
    redirect_url: string | null;
    tail_crawled: boolean;
  }>({
    header: ["source", "chain", "target", "hops"],
    keyset: ["url"],
    start: [""],
    query: (crawlId, cursor, limit) => sql`
      with recursive seeds as (
        select p.url from pages p
        where p.crawl_id = ${crawlId} and p.fetch_class = 'redirect'
          and p.url > ${cursor[0] ?? ""}::text
        order by p.url asc
        limit ${limit}
      ),
      walk as (
        select s.url as head, p.redirect_url as redirect_url,
               p.redirect_url_normalised as redirect_url_normalised,
               1 as depth, array[p.url] as chain, false as is_cycle
        from seeds s
        join pages p on p.crawl_id = ${crawlId} and p.url = s.url
        union all
        select w.head, p.redirect_url, p.redirect_url_normalised,
               w.depth + 1, w.chain || p.url, p.url = any(w.chain)
        from walk w
        join pages p on p.crawl_id = ${crawlId} and p.url = w.redirect_url_normalised
        where w.depth < ${MAX_REDIRECT_HOPS} and not w.is_cycle
      )
      select w1.head as source, w1.chain, w1.is_cycle, w1.redirect_url,
             exists (
               select 1 from pages q
               where q.crawl_id = ${crawlId} and q.url = w1.redirect_url_normalised
             ) as tail_crawled
      from walk w1
      where w1.depth = (select max(w2.depth) from walk w2 where w2.head = w1.head)
      order by w1.head asc`,
    next: (row) => [row.source],
    cells: (row) => {
      // A cycle's chain already ends on the URL it comes back to; anything else
      // gets its unvisited tail appended, because that hop is part of the path.
      const tail = row.is_cycle ? null : row.redirect_url;
      const chain = tail === null ? row.chain : [...row.chain, tail];
      // The walk stopped short exactly when the tail it did not follow has a
      // page row of its own — the hop cap, not the end of the path.
      const unresolved = tail !== null && row.tail_crawled;
      const last = chain[chain.length - 1];
      return [
        row.source,
        chain.join(LIST_SEPARATOR),
        unresolved || chain.length < 2 || last === undefined ? "" : last,
        String(chain.length - 1),
      ];
    },
  }),

  /**
   * Every distinct file this crawl's pages point at — the images, stylesheets
   * and scripts — with what the server said about it and how many pages carry
   * it. One row per FILE, which is the table's own grain: an image referenced by
   * four hundred pages is one fetch, one row, and a `referencingPages` of 400.
   *
   * ## `fetchClass` is a column here, and the file is unreadable without it
   *
   * The other views' empty cells all mean one thing ("the engine has no value"),
   * and here they mean four: never asked, asked and refused by our own URL
   * policy, put out of reach by robots.txt, or a request that never completed.
   * `status` is empty in every one of those cases, and in three of them nothing
   * about the file is wrong. So the class travels beside the status — an EMPTY
   * `fetchClass` is the null-vs-zero doctrine's newest citizen, "seen, not
   * asked" — and `fetchReason` carries the sentence that separates the rest.
   * Without both columns a reader of this file would have to guess, and the
   * guess a spreadsheet invites is "no status means broken".
   *
   * `bytesSource` rides beside `bytes` for the smaller version of the same
   * reason: `header` is a claim the server made and `counted` is a measurement
   * we took, and a page-weight sum built from the two without distinguishing
   * them is a number with two different provenances in it.
   *
   * `shareImage` is `true` for a file an `og:image` / `twitter:image` tag named.
   * Such a file is fetched, so it has a row, but a browser does not load it:
   * `referencingPages` is 0 unless a page also loads it as an asset.
   */
  resources: defineCsvView<{
    url: string;
    kind: string;
    share_image: boolean;
    fetch_class: string | null;
    status_code: number | null;
    bytes: number | null;
    bytes_source: string | null;
    content_type: string | null;
    cache_control: string | null;
    fetch_reason: string | null;
    referencing_pages: number;
  }>({
    header: [
      "url", "kind", "shareImage", "fetchClass", "status", "bytes", "bytesSource",
      "contentType", "cacheControl", "fetchReason", "referencingPages",
    ],
    keyset: ["url"],
    start: [""],
    query: (crawlId, cursor, limit) => sql`
      select r.url, r.kind, r.share_image, r.fetch_class, r.status_code, r.bytes,
             r.bytes_source,
             r.content_type, r.cache_control, r.fetch_reason,
             (select count(*)::int from page_resources pr
               where pr.crawl_id = r.crawl_id and pr.resource_url = r.url)
               as referencing_pages
      from resources r
      where r.crawl_id = ${crawlId} and r.url > ${cursor[0] ?? ""}::text
      order by r.url asc
      limit ${limit}`,
    next: (row) => [row.url],
    cells: (row) => [
      row.url,
      row.kind,
      String(row.share_image),
      orEmpty(row.fetch_class),
      orEmpty(row.status_code),
      orEmpty(row.bytes),
      orEmpty(row.bytes_source),
      orEmpty(row.content_type),
      orEmpty(row.cache_control),
      orEmpty(row.fetch_reason),
      String(row.referencing_pages),
    ],
  }),
};

/**
 * A view's `text/csv` filename, deterministic per (crawl, view, subject).
 *
 * A SCOPED EXPORT IS NAMED FOR ITS SUBJECT and not for its view (Phase 20):
 * `crawl_e36211fc-82ad-459b-a67f-d625ee7732ca-links.broken-internal.csv`, where
 * it used to carry `-issue_urls-` in the middle. The crawl component is the
 * WHOLE id — `slug` (src/api/service.ts) only replaces characters a filename
 * cannot hold, and a `crawl_<uuid>` has none — so the name is long, and that is
 * the trade: it is the id a client pastes back into the API. The file lands in
 * a Downloads folder beside a
 * dozen others and what a person is looking for there is the rule; `issue_urls`
 * is the engine's word for "one rule's findings" and says nothing a reader of
 * the filename needs.
 *
 * TWO VIEWS ARE SCOPED SINCE PHASE 21 — `issue_urls` by its rule and
 * `metric_table` by its metric — and the name stays unambiguous without a view
 * word because RULE IDS AND METRIC IDS ARE ONE NAMESPACE: the registry refuses a
 * duplicate id across the kinds, so `crawl_x-site.health.csv` and
 * `crawl_x-links.orphan.csv` can never name the same subject from two views.
 * A third scoped view whose subject is not a rule id would have to put its own
 * word back in.
 */
export function csvFilename(
  crawlSlug: string,
  view: CsvViewName,
  subjectSlug: string | null,
): string {
  return subjectSlug === null ? `${crawlSlug}-${view}.csv` : `${crawlSlug}-${subjectSlug}.csv`;
}

/**
 * THE METRIC TABLE AS A CSV, header and rows.
 *
 * The header is the LABELS — the table's own columns, led by the summary's.
 *
 * ## Why the summary becomes leading columns repeated on every row
 *
 * A CSV has one rectangle and no place above it. The site-level scalars
 * (`url.param-volumes`' four counts of the whole site's parameters) would
 * otherwise be dropped from the file — a spreadsheet that says "`_pos` appears
 * on 47 URLs" while losing "this site has 5 parameters on 61 URLs" — or written
 * as a comment block no parser reads. So they are columns, with their labels in
 * the header, carrying the SAME value on every row, and they lead rather than
 * trail because they are the context a reader needs before the first row means
 * anything. A reader who wants the rows alone deletes the first N columns; a
 * reader who never learns the site had four more numbers cannot.
 *
 * A cell is the value as the shaper produced it — numbers raw, booleans
 * `true`/`false`, and an EMPTY CELL for null, which is this file's one meaning
 * for "the engine has no value here".
 */
export function metricTableHeader(table: {
  summary: readonly { label: string }[];
  columns: readonly { label: string }[];
}): string[] {
  return [...table.summary.map((s) => s.label), ...table.columns.map((c) => c.label)];
}

/** One shaped row as cells, in `metricTableHeader` order. */
export function metricTableCells(
  table: {
    summary: readonly { value: string | number | boolean | null }[];
    columns: readonly { key: string }[];
  },
  row: Record<string, string | number | boolean | null>,
): string[] {
  return [
    ...table.summary.map((s) => orEmpty(s.value)),
    ...table.columns.map((column) => orEmpty(row[column.key])),
  ];
}

/** The Issues Overview's header — `Issue Name` is the rule's title. */
export const ISSUES_OVERVIEW_HEADER = [
  "Issue Name",
  "Issue Type",
  "Issue Priority",
  "Severity",
  "URLs",
  "% of Judged",
  "Description",
  "How To Fix",
  "Rule Id",
  "Check Ids",
];

/**
 * One overview row as cells, in `ISSUES_OVERVIEW_HEADER` order. `% of Judged` is
 * empty when the engine has no Pages Judged to divide by (this file's one
 * meaning for "no value").
 */
export function issuesOverviewCells(
  row: {
    ruleId: string;
    title: string;
    type: string;
    priority: string;
    severity: string;
    urls: number;
    percentOfJudged: number | null;
    checkIds: readonly string[];
  },
  copy: { explanation: string; howToFix: string },
): string[] {
  return [
    row.title,
    row.type,
    row.priority,
    row.severity,
    String(row.urls),
    orEmpty(row.percentOfJudged),
    copy.explanation,
    copy.howToFix,
    row.ruleId,
    row.checkIds.join(LIST_SEPARATOR),
  ];
}

/** The Crawl Overview's header. `Section` is the section's (or entry's) id. */
export const CRAWL_OVERVIEW_HEADER = ["Section", "Label", "Value", "Percent"];

/**
 * The Crawl Overview as CSV records, in `CRAWL_OVERVIEW_HEADER` order: one per
 * entry, in the JSON's order, then one per `notMeasured` item with
 * `Not measured: <reason>` as its label and EMPTY Value and Percent cells
 * (this file's one meaning for "no value"), never a zero.
 */
export function crawlOverviewRecords(overview: {
  sections: readonly {
    id: string;
    entries: readonly { label: string; value: number; percent: number | null }[];
  }[];
  notMeasured: readonly { id: string; reason: string }[];
}): string[][] {
  const out: string[][] = [];
  for (const section of overview.sections) {
    for (const e of section.entries) {
      out.push([section.id, e.label, String(e.value), orEmpty(e.percent)]);
    }
  }
  for (const n of overview.notMeasured) out.push([n.id, `Not measured: ${n.reason}`, "", ""]);
  return out;
}

/**
 * The CSV surface: one writer, one evidence flattening, six views.
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

import { MAX_REDIRECT_HOPS } from "../rules/query/redirects.js";

/** The datasets `export_crawl`'s CSV half can write, and the `view` vocabulary. */
export const CSV_VIEWS = [
  "issues",
  "issue_urls",
  "internal_urls",
  "links_to_4xx",
  "anchor_texts",
  "redirects",
] as const;
export type CsvViewName = (typeof CSV_VIEWS)[number];

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
 */
export function csvCell(value: string): string {
  const guarded = FORMULA_LEADERS.includes(value.slice(0, 1)) ? `'${value}` : value;
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

/** The depth-first walk `flattenEvidence` is: sorted keys, indexed elements. */
function walk(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${path}=[]`);
      return;
    }
    if (value.every((item) => item === null || typeof item !== "object")) {
      out.push(`${path}=${value.map(scalar).join(LIST_SEPARATOR)}`);
      return;
    }
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !(path === "" && key === "pageUrl"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) {
      // The top level is not a leaf: evidence holding nothing but a pageUrl is
      // an empty cell, not a `{}`.
      if (path !== "") out.push(`${path}={}`);
      return;
    }
    for (const [key, child] of entries) walk(child, path === "" ? key : `${path}.${key}`, out);
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
  /** The header row, always written. */
  readonly header: readonly string[];
  /** The columns the cursor is made of — documentation, and the start's arity. */
  readonly keyset: readonly string[];
  /** A cursor that sorts before every real row. Every view starts here. */
  readonly start: readonly string[];
  /** Whether the view is about one rule and cannot be built without its id. */
  readonly needsRuleId: boolean;
  /** One bounded, ordered batch after `cursor`. */
  query(crawlId: string, cursor: readonly string[], limit: number, ruleId: string | null): SQL;
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
  header: readonly string[];
  keyset: readonly string[];
  start: readonly string[];
  needsRuleId?: boolean;
  query(crawlId: string, cursor: readonly string[], limit: number, ruleId: string | null): SQL;
  next(row: Row): string[];
  cells(row: Row, ctx: CsvViewContext): string[];
}): CsvView {
  return {
    header: view.header,
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

/** A text column that must be a string, or the empty cell. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const ISSUE_HEADER = ["ruleId", "severity", "category", "checkIds", "url", "title", "evidence"];

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

function linkNext(row: LinkRow): string[] {
  return [row.source_page_id, row.target, String(row.position)];
}

/**
 * The six views.
 *
 * Every one of them answers a question the Ahrefs-style bulk-export block asks,
 * and every one of them is a read the JSON surface could already answer more
 * slowly, page by page. Nothing here judges.
 */
export const CSV_VIEW_DEFS: Record<CsvViewName, CsvView> = {
  /**
   * Every finding of a judged crawl, one row each — the same rows, in the same
   * order, as the `issues` JSONL dataset, with the evidence flattened.
   */
  issues: defineCsvView<IssueRow>({
    header: ISSUE_HEADER,
    keyset: ["rule_id", "dedupe_key"],
    start: ["", ""],
    query: (crawlId, cursor, limit) => sql`
      select i.rule_id, i.severity,
             i.details_jsonb->>'pageUrl' as url,
             i.details_jsonb as evidence,
             i.dedupe_key
      from issues i
      where i.crawl_id = ${crawlId}
        and (i.rule_id, i.dedupe_key) > (${cursor[0] ?? ""}::text, ${cursor[1] ?? ""}::text)
      order by i.rule_id asc, i.dedupe_key asc
      limit ${limit}`,
    next: (row) => [row.rule_id, row.dedupe_key],
    cells: (row, ctx) => {
      const rule = ctx.rule(row.rule_id);
      return [
        row.rule_id,
        row.severity,
        rule.category,
        rule.checkIds.join(LIST_SEPARATOR),
        orEmpty(row.url),
        rule.title,
        flattenEvidence(ctx.evidence(row.evidence, row.rule_id)),
      ];
    },
  }),

  /** One rule's findings, URL by URL — the drill-down as a spreadsheet. */
  issue_urls: defineCsvView<IssueRow>({
    header: ["ruleId", "url", "evidence"],
    keyset: ["dedupe_key"],
    start: [""],
    needsRuleId: true,
    query: (crawlId, cursor, limit, ruleId) => sql`
      select i.rule_id, i.severity,
             i.details_jsonb->>'pageUrl' as url,
             i.details_jsonb as evidence,
             i.dedupe_key
      from issues i
      where i.crawl_id = ${crawlId} and i.rule_id = ${ruleId ?? ""}
        and i.dedupe_key > ${cursor[0] ?? ""}::text
      order by i.dedupe_key asc
      limit ${limit}`,
    next: (row) => [row.dedupe_key],
    cells: (row, ctx) => [
      row.rule_id,
      orEmpty(row.url),
      flattenEvidence(ctx.evidence(row.evidence, row.rule_id)),
    ],
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
  }>({
    header: ["url", "status", "fetchClass", "indexable", "clickDepth", "pageType", "title"],
    keyset: ["url"],
    start: [""],
    query: (crawlId, cursor, limit) => sql`
      select p.url, p.status_code, p.fetch_class, p.is_indexable,
             p.click_depth, p.page_type, p.title
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
    ],
  }),

  /**
   * Internal links whose target answered 4xx — the broken-link worksheet, one
   * row per LINK rather than per target, because the fix is made in the source
   * page's markup.
   *
   * Internal only, and that is not a filter but the join: an external target is
   * never fetched, so this engine has no status to report for it and will not
   * invent one. The target's class is the crawl's own (`client_error`), which is
   * the same predicate `links.broken-internal` fires on.
   */
  links_to_4xx: defineCsvView<LinkRow & { status_code: number | null }>({
    header: ["source", "target", "status", "anchorText"],
    keyset: [...LINK_KEYSET],
    start: [...LINK_START],
    query: (crawlId, cursor, limit) => sql`
      select src.url as source, l.target_url as target, l.anchor,
             tgt.status_code, l.source_page_id, l.position
      from links l
      join pages src on src.crawl_id = ${crawlId} and src.id = l.source_page_id
      join pages tgt on tgt.crawl_id = ${crawlId} and tgt.url = l.target_url
      where ${linkKeyset(crawlId, cursor)}
        and l.is_internal and tgt.fetch_class = 'client_error'
      order by l.source_page_id asc, l.target_url asc, l.position asc
      limit ${limit}`,
    next: linkNext,
    cells: (row) => [row.source, row.target, orEmpty(row.status_code), orEmpty(row.anchor)],
  }),

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
};

/** A view's `text/csv` filename, deterministic per (crawl, view, rule). */
export function csvFilename(crawlSlug: string, view: CsvViewName, ruleSlug: string | null): string {
  return ruleSlug === null
    ? `${crawlSlug}-${view}.csv`
    : `${crawlSlug}-${view}-${ruleSlug}.csv`;
}

/** The header text, as a view's first record. */
export function csvHeader(view: CsvViewName): string {
  return csvRecord(CSV_VIEW_DEFS[view].header);
}

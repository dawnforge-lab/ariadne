/**
 * `crawl_diff` (Phase 29c, rulings R9-R11): a field-level diff of two judged
 * crawls of one site, joined on `pages.url`, over STORED FACTS only (nothing is
 * fetched, no rule runs).
 *
 * THE JOIN IS ON `pages.url`, not `url_normalised`: `/Page` and `/page`, or `/a`
 * and `/a/`, are distinct stored urls that can share a normalised form, and a
 * diff joined on the normalised one would pair them with each other and report
 * the real pair as removed and added.
 *
 * ONE STATEMENT (`diffSummarySql`): a `count(*) filter (where ...)` per field
 * over `diffJoinSql`, so memory is O(1) in pages and the answer is one
 * snapshot. Task 8's URL listing reuses `diffJoinSql` and `DIFF_FIELDS`.
 *
 * COMPARABILITY (R10), stated per field, never silent: a pair that cannot be
 * compared for a field is counted as `notComparable`, not as unchanged.
 *  - content fields (title, meta description, h1, canonical, meta robots, word
 *    count, schema types): either side's `fetch_class <> 'ok'`, since nothing
 *    was parsed, and status / fetchClass already report that change;
 *  - meta robots: either side extraction_version < 2 or null (it changed meaning);
 *  - schema types: either side extraction_version < 4 or null (microdata, RDFa);
 *  - inlinks and link score: either side's `inlinks_internal` null (judged
 *    before 29c, not measured, which is not zero).
 * Status, fetch class, indexable and click depth are comparable on every common
 * url (a null click depth on a judged crawl is "unreachable", a value).
 */
import { sql, type SQL } from "drizzle-orm";

import { ServiceError, clip } from "./errors.js";

/** The aliases the join gives each side: the `pages` row and its schema-type set. */
export interface DiffSide {
  /** The side's `pages` row alias. */
  p: SQL;
  /** The side's sorted distinct schema types, `text[]` (empty when it has none). */
  types: SQL;
}

export const BASE_SIDE: DiffSide = { p: sql.raw("b"), types: sql.raw("bs.types") };
export const HEAD_SIDE: DiffSide = { p: sql.raw("h"), types: sql.raw("hs.types") };

/** The four request parameters, all integers. */
export interface DiffThresholds {
  wordCountChangePct: number;
  inlinksChangePct: number;
  inlinksChangeMin: number;
  linkScoreChangePoints: number;
}

interface ThresholdSpec {
  def: number;
  min: number;
  max: number;
}

export const DIFF_THRESHOLD_SPECS: Record<keyof DiffThresholds, ThresholdSpec> = {
  wordCountChangePct: { def: 20, min: 1, max: 1000 },
  inlinksChangePct: { def: 50, min: 1, max: 1000 },
  inlinksChangeMin: { def: 5, min: 1, max: 100000 },
  linkScoreChangePoints: { def: 10, min: 1, max: 100 },
};

/**
 * The thresholds of a request: absent means the default, anything else must be
 * an integer in range or the call is refused naming the parameter. Unknown keys
 * are not this function's concern (both transports close their schemas).
 */
export function parseDiffThresholds(raw: Partial<Record<keyof DiffThresholds, unknown>> = {}): DiffThresholds {
  const out = {} as DiffThresholds;
  for (const name of Object.keys(DIFF_THRESHOLD_SPECS) as (keyof DiffThresholds)[]) {
    const spec = DIFF_THRESHOLD_SPECS[name];
    const value = raw[name];
    if (value === undefined) {
      out[name] = spec.def;
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max) {
      throw new ServiceError(
        "VALIDATION",
        `${name} must be an integer from ${spec.min} to ${spec.max}, got ${clip(JSON.stringify(value))}`,
      );
    }
    out[name] = value;
  }
  return out;
}

export interface DiffField {
  name: string;
  /** True when this pair of rows can be compared for the field. Never null. */
  comparable(b: DiffSide, h: DiffSide): SQL;
  /** True when the field differs. Only meaningful where `comparable` is true. */
  changed(b: DiffSide, h: DiffSide, t: DiffThresholds): SQL;
  /** The base side's value, for Task 8's listing. */
  before(b: DiffSide): SQL;
  /** The head side's value, for Task 8's listing. */
  after(h: DiffSide): SQL;
}

const col = (side: DiffSide, name: string): SQL => sql`${side.p}.${sql.raw(name)}`;
const always = (): SQL => sql`true`;
const bothOk = (b: DiffSide, h: DiffSide): SQL =>
  sql`(${col(b, "fetch_class")} = 'ok' and ${col(h, "fetch_class")} = 'ok')`;
const extractionAtLeast = (b: DiffSide, h: DiffSide, v: number): SQL =>
  sql`(coalesce(${col(b, "extraction_version")}, 0) >= ${v}::int and coalesce(${col(h, "extraction_version")}, 0) >= ${v}::int)`;
const bothMeasured = (b: DiffSide, h: DiffSide): SQL =>
  sql`(${col(b, "inlinks_internal")} is not null and ${col(h, "inlinks_internal")} is not null)`;

/** A field compared by `is distinct from` on one column. */
function exact(name: string, column: string, comparable: DiffField["comparable"] = always): DiffField {
  return {
    name,
    comparable,
    changed: (b, h) => sql`${col(b, column)} is distinct from ${col(h, column)}`,
    before: (b) => col(b, column),
    after: (h) => col(h, column),
  };
}

const content = (b: DiffSide, h: DiffSide): SQL => bothOk(b, h);

export const DIFF_FIELDS: readonly DiffField[] = [
  exact("status", "status_code"),
  exact("fetchClass", "fetch_class"),
  exact("indexable", "is_indexable"),
  exact("title", "title", content),
  exact("metaDescription", "meta_description", content),
  exact("h1", "h1_text", content),
  {
    name: "canonical",
    comparable: content,
    changed: (b, h) =>
      sql`(${col(b, "canonical_html")} is distinct from ${col(h, "canonical_html")} or ${col(b, "canonical_header")} is distinct from ${col(h, "canonical_header")})`,
    before: (b) => sql`jsonb_build_object('html', ${col(b, "canonical_html")}, 'header', ${col(b, "canonical_header")})`,
    after: (h) => sql`jsonb_build_object('html', ${col(h, "canonical_html")}, 'header', ${col(h, "canonical_header")})`,
  },
  exact("metaRobots", "robots_meta", (b, h) => sql`(${bothOk(b, h)} and ${extractionAtLeast(b, h, 2)})`),
  {
    name: "wordCount",
    // A null word count on an ok page is a row this engine did not write
    // whole: counted as not comparable, never as unchanged.
    comparable: (b, h) =>
      sql`(${bothOk(b, h)} and ${col(b, "word_count")} is not null and ${col(h, "word_count")} is not null)`,
    changed: (b, h, t) =>
      sql`(abs(${col(h, "word_count")} - ${col(b, "word_count")}) * 100 > ${t.wordCountChangePct}::int * ${col(b, "word_count")})`,
    before: (b) => col(b, "word_count"),
    after: (h) => col(h, "word_count"),
  },
  {
    name: "schemaTypes",
    comparable: (b, h) => sql`(${bothOk(b, h)} and ${extractionAtLeast(b, h, 4)})`,
    changed: (b, h) => sql`${b.types} is distinct from ${h.types}`,
    before: (b) => sql`to_jsonb(${b.types})`,
    after: (h) => sql`to_jsonb(${h.types})`,
  },
  {
    name: "inlinks",
    comparable: bothMeasured,
    changed: (b, h, t) =>
      sql`(abs(${col(h, "inlinks_internal")} - ${col(b, "inlinks_internal")}) >= ${t.inlinksChangeMin}::int
        and abs(${col(h, "inlinks_internal")} - ${col(b, "inlinks_internal")}) * 100 > ${t.inlinksChangePct}::int * ${col(b, "inlinks_internal")})`,
    before: (b) => col(b, "inlinks_internal"),
    after: (h) => col(h, "inlinks_internal"),
  },
  exact("clickDepth", "click_depth"),
  {
    name: "linkScore",
    comparable: bothMeasured,
    // Scored on one side only is a change (a page entering or leaving the
    // graph); both scored compares by points. Both unscored is no change.
    changed: (b, h, t) =>
      sql`((${col(b, "link_score")} is null) <> (${col(h, "link_score")} is null)
        or coalesce(abs(${col(h, "link_score")} - ${col(b, "link_score")}) >= ${t.linkScoreChangePoints}::int, false))`,
    before: (b) => col(b, "link_score"),
    after: (h) => col(h, "link_score"),
  },
];

export const DIFF_FIELD_NAMES = [
  "status", "fetchClass", "indexable", "title", "metaDescription", "h1", "canonical",
  "metaRobots", "wordCount", "schemaTypes", "inlinks", "clickDepth", "linkScore",
] as const;

/**
 * The two crawls' pages, full-joined on `url`, each side's schema-type set as a
 * lateral aggregate: aliases `b`, `h`, `bs`, `hs` (see `BASE_SIDE`/`HEAD_SIDE`).
 * A url on one side only has null columns on the other (`b.id is null` is
 * "added", `h.id is null` is "removed").
 */
export function diffJoinSql(baseId: string, headId: string): SQL {
  return sql`
    (select * from pages where crawl_id = ${baseId}) b
    full join (select * from pages where crawl_id = ${headId}) h on h.url = b.url
    cross join lateral (
      select coalesce(array_agg(distinct schema_type order by schema_type), '{}'::text[]) as types
        from structured_data where crawl_id = ${baseId} and page_id = b.id
    ) bs
    cross join lateral (
      select coalesce(array_agg(distinct schema_type order by schema_type), '{}'::text[]) as types
        from structured_data where crawl_id = ${headId} and page_id = h.id
    ) hs`;
}

/** `b` and `h` both present: the pairs a field can be compared over. */
export const COMMON_SQL: SQL = sql`(b.id is not null and h.id is not null)`;

export interface CrawlDiffField {
  field: string;
  changed: number;
  notComparable: number;
}

/** The one statement: url sets, per-side page counts, and a changed / notComparable pair per field. */
export function diffSummarySql(baseId: string, headId: string, t: DiffThresholds): SQL {
  const parts: SQL[] = [
    sql`count(b.id)::int as base_pages`,
    sql`count(h.id)::int as head_pages`,
    sql`count(*) filter (where ${COMMON_SQL})::int as common`,
    sql`count(*) filter (where h.id is null)::int as removed`,
    sql`count(*) filter (where b.id is null)::int as added`,
  ];
  DIFF_FIELDS.forEach((f, i) => {
    parts.push(
      sql`count(*) filter (where ${COMMON_SQL} and ${f.comparable(BASE_SIDE, HEAD_SIDE)} and ${f.changed(BASE_SIDE, HEAD_SIDE, t)})::int as ${sql.raw(`changed_${i}`)}`,
      sql`count(*) filter (where ${COMMON_SQL} and not ${f.comparable(BASE_SIDE, HEAD_SIDE)})::int as ${sql.raw(`nc_${i}`)}`,
    );
  });
  return sql`select ${sql.join(parts, sql`, `)} from ${diffJoinSql(baseId, headId)}`;
}

export type DiffSummaryRow = Record<string, number>;

/** Shape one summary row into the answer's `fields`, in `DIFF_FIELDS` order. */
export function diffFieldsOf(row: DiffSummaryRow): CrawlDiffField[] {
  return DIFF_FIELDS.map((f, i) => {
    const changed = row[`changed_${i}`];
    const notComparable = row[`nc_${i}`];
    if (typeof changed !== "number" || typeof notComparable !== "number") {
      throw new Error(`crawl diff: the summary row has no count for field '${f.name}'`);
    }
    return { field: f.name, changed, notComparable };
  });
}

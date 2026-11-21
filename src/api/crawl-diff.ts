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
 * TWO ADDRESSES OF ONE SITE ARE MATCHED ON PATH (owner ruling, 2026-11-21). The
 * pairing refusal admits two crawls of one host family (apex and www) under any
 * scheme, so a site moved from http to https or from the apex to www is one
 * site. Joined on the exact url, every page of such a pair would read removed
 * and added. When the two crawls' site origins differ (`diffRebaseOf`), each
 * BASE url on the base's own origin is read in the head's origin before the
 * join (`http://a.example/x` -> `https://www.a.example/x`): path and query
 * still have to match exactly, as above. A base url on any other origin (a
 * subdomain, or a page the base already stored at the head's address) is
 * matched as it is. Two base urls that would land on one head url are refused,
 * never paired by a guess (`diffRebaseCollisionSql`). The answer says which
 * matching it used (`matchedBy`), and every listed url carries the base's own
 * url beside it (`baseUrl`).
 *
 * ONE STATEMENT (`diffSummarySql`): a `count(*) filter (where ...)` per field
 * over `diffJoinSql`, so memory is O(1) in pages and the answer is one
 * snapshot. The url listing (`crawl_diff_urls`) reuses `diffJoinSql` and `DIFF_FIELDS`.
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

export const DIFF_FIELD_NAMES = [
  "status", "fetchClass", "indexable", "title", "metaDescription", "h1", "canonical",
  "metaRobots", "wordCount", "schemaTypes", "inlinks", "clickDepth", "linkScore",
] as const;

export type DiffFieldName = (typeof DIFF_FIELD_NAMES)[number];

export interface DiffField {
  name: DiffFieldName;
  /** True when this pair of rows can be compared for the field. Never null. */
  comparable(b: DiffSide, h: DiffSide): SQL;
  /** True when the field differs. Only meaningful where `comparable` is true. */
  changed(b: DiffSide, h: DiffSide, t: DiffThresholds): SQL;
  /** The base side's value, for the url listing. */
  before(b: DiffSide): SQL;
  /** The head side's value, for the url listing. */
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
function exact(name: DiffFieldName, column: string, comparable: DiffField["comparable"] = always): DiffField {
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
    // The base's canonicals as read in the head's address (`rebasedSql`, the
    // stored value when the origins agree); the listing's `before` shows them
    // as stored.
    changed: (b, h) =>
      sql`(${col(b, "match_canonical_html")} is distinct from ${col(h, "canonical_html")} or ${col(b, "match_canonical_header")} is distinct from ${col(h, "canonical_header")})`,
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
      sql`(abs(${col(h, "word_count")}::bigint - ${col(b, "word_count")}::bigint) * 100 > ${t.wordCountChangePct}::bigint * ${col(b, "word_count")}::bigint)`,
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
        and abs(${col(h, "inlinks_internal")}::bigint - ${col(b, "inlinks_internal")}::bigint) * 100 > ${t.inlinksChangePct}::bigint * ${col(b, "inlinks_internal")}::bigint)`,
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


/**
 * How a diff pairs urls: `null` when both crawls' site urls share an origin
 * (the exact url), or the base origin to read in the head's when they do not.
 * The origin is scheme, host and port: `https://a.example/` and
 * `https://a.example/shop/` share one, `http://` and `https://` do not.
 */
export interface DiffRebase {
  /** The base crawl's site origin, e.g. `http://a.example`. */
  from: string;
  /** The head crawl's site origin, e.g. `https://www.a.example`. */
  to: string;
}

export function diffRebaseOf(baseSiteUrl: string, headSiteUrl: string): DiffRebase | null {
  const from = new URL(baseSiteUrl).origin;
  const to = new URL(headSiteUrl).origin;
  return from === to ? null : { from, to };
}

/**
 * A url-valued base column as the diff reads it: the stored value, or, under a
 * rebase, the value read in the head's origin when it is on the base's own
 * origin. Applied to the page url (the join key) and to the two canonicals, so
 * a self-canonical that moved with the site is unchanged and a head canonical
 * still naming the old address is a change. The origin is followed by `/` in
 * every stored url (`normalizeUrl` gives every url a path), and the `/` is part
 * of the test, so `http://a.example.evil/` is not on `http://a.example`.
 */
function rebasedSql(column: "url" | "canonical_html" | "canonical_header", rebase: DiffRebase | null): SQL {
  const c = sql.raw(column);
  if (rebase === null) return c;
  return sql`case when starts_with(${c}, ${`${rebase.from}/`}::text)
                  then ${rebase.to}::text || substr(${c}, ${rebase.from.length + 1}::int)
                  else ${c} end`;
}

/**
 * The two crawls' pages, full-joined on the base's match url (`baseMatchUrlSql`:
 * the stored url unless the origins differ) against the head's stored url, each
 * side's schema-type set as a lateral aggregate: aliases `b`, `h`, `bs`, `hs`
 * (see `BASE_SIDE`/`HEAD_SIDE`); `b.match_url` is the base's url as joined, and
 * `b.match_canonical_html` / `b.match_canonical_header` its canonicals read the
 * same way. A url on one side only has null columns on the other (`b.id is null`
 * is "added", `h.id is null` is "removed").
 */
export function diffJoinSql(baseId: string, headId: string, rebase: DiffRebase | null): SQL {
  return sql`
    (select *, ${rebasedSql("url", rebase)} as match_url,
            ${rebasedSql("canonical_html", rebase)} as match_canonical_html,
            ${rebasedSql("canonical_header", rebase)} as match_canonical_header
       from pages where crawl_id = ${baseId}) b
    full join (select * from pages where crawl_id = ${headId}) h on h.url = b.match_url
    cross join lateral (
      select coalesce(array_agg(distinct schema_type order by schema_type), '{}'::text[]) as types
        from structured_data where crawl_id = ${baseId} and page_id = b.id
    ) bs
    cross join lateral (
      select coalesce(array_agg(distinct schema_type order by schema_type), '{}'::text[]) as types
        from structured_data where crawl_id = ${headId} and page_id = h.id
    ) hs`;
}

/**
 * Under a rebase, the first head url that two base pages would both pair with,
 * and those base urls (sorted), or no row. Never run without a rebase: a
 * crawl's stored urls are unique (`pages_crawl_url`), so the exact join cannot
 * pair two base pages with one head page.
 */
export function diffRebaseCollisionSql(baseId: string, rebase: DiffRebase): SQL {
  return sql`
    select match_url, array_agg(url order by url) as urls
      from (select url, ${rebasedSql("url", rebase)} as match_url from pages where crawl_id = ${baseId}) b
     group by match_url
    having count(*) > 1
     order by match_url
     limit 1`;
}

/** `b` and `h` both present: the pairs a field can be compared over. */
export const COMMON_SQL: SQL = sql`(b.id is not null and h.id is not null)`;

export interface CrawlDiffField {
  field: string;
  changed: number;
  notComparable: number;
}

/**
 * THE ONE DEFINITION of "changed" and "notComparable" per field, shared by the
 * summary's counts and the url listing (`crawl_diff_urls`), so a listing walked
 * to its end has exactly as many urls as the summary said.
 */
export const fieldChangedWhere = (f: DiffField, t: DiffThresholds): SQL =>
  sql`(${COMMON_SQL} and ${f.comparable(BASE_SIDE, HEAD_SIDE)} and ${f.changed(BASE_SIDE, HEAD_SIDE, t)})`;
export const fieldNotComparableWhere = (f: DiffField): SQL =>
  sql`(${COMMON_SQL} and not ${f.comparable(BASE_SIDE, HEAD_SIDE)})`;

/** The one statement: url sets, per-side page counts, and a changed / notComparable pair per field. */
export function diffSummarySql(baseId: string, headId: string, t: DiffThresholds, rebase: DiffRebase | null): SQL {
  const parts: SQL[] = [
    sql`count(b.id)::int as base_pages`,
    sql`count(h.id)::int as head_pages`,
    sql`count(*) filter (where ${COMMON_SQL})::int as common`,
    sql`count(*) filter (where h.id is null)::int as removed`,
    sql`count(*) filter (where b.id is null)::int as added`,
  ];
  DIFF_FIELDS.forEach((f, i) => {
    parts.push(
      sql`count(*) filter (where ${fieldChangedWhere(f, t)})::int as ${sql.raw(`changed_${i}`)}`,
      sql`count(*) filter (where ${fieldNotComparableWhere(f)})::int as ${sql.raw(`nc_${i}`)}`,
    );
  });
  return sql`select ${sql.join(parts, sql`, `)} from ${diffJoinSql(baseId, headId, rebase)}`;
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

export const DIFF_URL_SETS = ["added", "removed"] as const;
export const DIFF_STATES = ["changed", "notComparable"] as const;
export type DiffState = (typeof DIFF_STATES)[number];

/** What `field` of `crawl_diff_urls` accepts: every diff field, then the two url sets. */
export const DIFF_URL_FIELDS: readonly string[] = [...DIFF_FIELD_NAMES, ...DIFF_URL_SETS];

/**
 * One url behind a count. `url` is the page's url in the head crawl's address
 * (the head's stored url, or for a removed page the base's url as matched);
 * `baseUrl` is the base crawl's own stored url, null for an added page. The two
 * differ only when the crawls' origins do (`matchedBy: "path"`). `before` and
 * `after` are null for `added` and `removed`.
 */
export type DiffUrl = {
  url: string;
  baseUrl: string | null;
  before: unknown;
  after: unknown;
};

export interface DiffUrlsRequest {
  field: DiffFieldName | (typeof DIFF_URL_SETS)[number];
  /** Null for `added` and `removed`, which have no state. */
  state: DiffState | null;
}

/** A refusal of `field` / `state`, naming the accepted values. Thrown before any read. */
export function parseDiffUrlsRequest(field: string, state: string | undefined): DiffUrlsRequest {
  const isSet = (DIFF_URL_SETS as readonly string[]).includes(field);
  const isField = (DIFF_FIELD_NAMES as readonly string[]).includes(field);
  if (!isSet && !isField) {
    throw new ServiceError(
      "VALIDATION",
      `field must be one of ${DIFF_URL_FIELDS.join(", ")}, got ${clip(JSON.stringify(field))}`,
    );
  }
  if (isSet) {
    if (state !== undefined) {
      throw new ServiceError("VALIDATION", `state does not apply to '${field}': added and removed have no state`);
    }
    return { field: field as DiffUrlsRequest["field"], state: null };
  }
  const chosen = state === undefined ? "changed" : state;
  if (!(DIFF_STATES as readonly string[]).includes(chosen)) {
    throw new ServiceError(
      "VALIDATION",
      `state must be one of ${DIFF_STATES.join(", ")}, got ${clip(JSON.stringify(state))}`,
    );
  }
  return { field: field as DiffUrlsRequest["field"], state: chosen as DiffState };
}

/**
 * One page of the urls behind a count: keyset on the matched url (`url` of
 * `DiffUrl`, unique: the head's urls are, and so are the base's match urls once
 * `diffRebaseCollisionSql` found no collision), `limit + 1` rows so the caller
 * can tell whether a next page exists. The predicates are `fieldChangedWhere` /
 * `fieldNotComparableWhere`, the summary's own.
 */
export function diffUrlsSql(
  baseId: string,
  headId: string,
  req: DiffUrlsRequest,
  t: DiffThresholds,
  cursor: string | null,
  limit: number,
  rebase: DiffRebase | null,
): SQL {
  let where: SQL;
  let before: SQL = sql`null::jsonb`;
  let after: SQL = sql`null::jsonb`;
  if (req.field === "added") {
    where = sql`b.id is null`;
  } else if (req.field === "removed") {
    where = sql`h.id is null`;
  } else {
    const name = req.field;
    const f = DIFF_FIELDS.find((x) => x.name === name);
    if (f === undefined) throw new Error(`crawl diff: no field definition for '${name}'`);
    where = req.state === "changed" ? fieldChangedWhere(f, t) : fieldNotComparableWhere(f);
    before = sql`to_jsonb(${f.before(BASE_SIDE)})`;
    after = sql`to_jsonb(${f.after(HEAD_SIDE)})`;
  }
  const key = sql`coalesce(h.url, b.match_url)`;
  return sql`
    select ${key} as url, b.url as "baseUrl", ${before} as before, ${after} as after
      from ${diffJoinSql(baseId, headId, rebase)}
     where ${where} ${cursor === null ? sql`` : sql`and ${key} > ${cursor}`}
     order by ${key} asc
     limit ${limit + 1}`;
}

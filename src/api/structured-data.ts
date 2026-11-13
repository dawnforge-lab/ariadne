/**
 * The structured-data surface's shared vocabulary and SQL (Phase 29a T9): the
 * `structured_data` listing (`ApiService.listStructuredData`) and the
 * `structured_data_nodes` CSV view (src/api/csv.ts) read the same
 * `validation_jsonb` blobs (`BlockValidation`, src/rules/schema-org/validate.ts),
 * so what counts as a problem, and what makes a blob readable, is said once here.
 *
 * Every count is taken in SQL over the rows of the pages being answered — never
 * by loading a crawl's blobs into memory (hard rule 6).
 *
 * ## The two severities (ruling R0.8)
 *
 * The registry has no "error" severity, so the listing's counts are named after
 * the two it has:
 *  - a WARNING is an unknown type, an unknown property, a type mismatch, a
 *    matched Google feature missing a required property, and every JSON-LD
 *    parse error and microdata error on the page;
 *  - an INFO is a pending or superseded property, a matched Google feature
 *    missing a recommended property, and markup for a withdrawn feature.
 */
import { sql, type SQL } from "drizzle-orm";

import type { StructuredDataFormat, StructuredDataSkips } from "../crawl/parse/page-analyzer.js";
import { GOOGLE_FEATURES } from "../rules/schema-org/google-features.js";
import { ServiceError, clip } from "./errors.js";

/** The keys of `StructuredDataSkips`, which a stored `structured_data_skips` must hold exactly. */
const SKIP_KEYS = ["microdataItemrefSkipped", "rdfaUnsupported", "valuesCapped"] as const satisfies readonly (keyof StructuredDataSkips)[];
type MissingSkipKey = Exclude<keyof StructuredDataSkips, (typeof SKIP_KEYS)[number]>;
const _everySkipKey: MissingSkipKey extends never ? true : never = true;
void _everySkipKey;

/**
 * A page's stored `structured_data_skips`, projected key by key onto the wire
 * (Talos obligation 6: named fields, never a stored blob passed through).
 *
 * Null stays null — a page extracted below version 4, which never counted.
 * Anything but an object of exactly the three non-negative integer counters is
 * a row this engine did not write, and throws naming the crawl and page rather
 * than dropping a key or answering a partial object.
 */
export function projectSkips(value: unknown, crawlId: string, url: string): StructuredDataSkips | null {
  if (value === null) return null;
  const bad = (why: string): never => {
    throw new Error(`crawl ${crawlId}, page ${url}: structured_data_skips ${why}`);
  };
  if (typeof value !== "object" || Array.isArray(value)) return bad("is not an object");
  const stored = value as Record<string, unknown>;
  const keys = Object.keys(stored).sort();
  if (keys.join(",") !== [...SKIP_KEYS].sort().join(",")) {
    return bad(`holds keys [${keys.join(", ")}], not exactly [${SKIP_KEYS.join(", ")}]`);
  }
  const count = (key: (typeof SKIP_KEYS)[number]): number => {
    const n = stored[key];
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : bad(`has a ${key} that is not a non-negative integer`);
  };
  return {
    microdataItemrefSkipped: count("microdataItemrefSkipped"),
    rdfaUnsupported: count("rdfaUnsupported"),
    valuesCapped: count("valuesCapped"),
  };
}

/** The syntaxes a block is stored from — the `format` filter's closed vocabulary. */
export const STRUCTURED_DATA_FORMATS = ["jsonld", "microdata", "rdfa"] as const satisfies readonly StructuredDataFormat[];
// Both directions: a format added to the parser's union and not here fails to
// compile, as does a value here the parser cannot write.
type MissingFormat = Exclude<StructuredDataFormat, (typeof STRUCTURED_DATA_FORMATS)[number]>;
const _everyFormat: MissingFormat extends never ? true : never = true;
void _everyFormat;

/** The Google feature ids the `feature` filter accepts. */
export const GOOGLE_FEATURE_IDS: readonly string[] = GOOGLE_FEATURES.map((f) => f.id);

/** The `structured_data_nodes` view's `Problem` vocabulary, in the order a block's rows are written. */
export const STRUCTURED_DATA_PROBLEMS = [
  "unknown-type",
  "unknown-property",
  "property-status",
  "type-mismatch",
  "google-required",
  "google-recommended",
  "deprecated-feature",
] as const;
export type StructuredDataProblem = (typeof STRUCTURED_DATA_PROBLEMS)[number];

/** The `BlockValidation` lists the surface reads. A blob without all six is unreadable. */
const VALIDATION_LISTS = [
  "unknownTypes",
  "unknownProperties",
  "propertyStatus",
  "typeMismatches",
  "googleFeatures",
  "deprecatedFeatures",
] as const;

/** Refuses a `format` outside the three, naming them. */
export function parseStructuredDataFormat(value: string): StructuredDataFormat {
  if (!(STRUCTURED_DATA_FORMATS as readonly string[]).includes(value)) {
    throw new ServiceError(
      "VALIDATION",
      `format '${clip(value)}' is not a structured-data format (one of: ${STRUCTURED_DATA_FORMATS.join(", ")})`,
    );
  }
  return value as StructuredDataFormat;
}

/**
 * A stored `format` value, checked: the column is text, and a value the writer
 * cannot produce is a row this engine did not write — thrown, naming crawl and
 * page, never passed through or coerced.
 */
export function storedFormat(value: string, crawlId: string, url: string): StructuredDataFormat {
  if (!(STRUCTURED_DATA_FORMATS as readonly string[]).includes(value)) {
    throw new Error(
      `crawl ${crawlId}, page ${url}: a structured_data row has format '${value}', which ` +
        `is not one of ${STRUCTURED_DATA_FORMATS.join(", ")}`,
    );
  }
  return value as StructuredDataFormat;
}

/** Refuses a `feature` that is not a Google feature id the profiles define, naming them. */
export function parseGoogleFeature(value: string): string {
  if (!GOOGLE_FEATURE_IDS.includes(value)) {
    throw new ServiceError(
      "VALIDATION",
      `feature '${clip(value)}' is not a Google feature this engine profiles ` +
        `(one of: ${GOOGLE_FEATURE_IDS.join(", ")})`,
    );
  }
  return value;
}

/** A list of the blob, by name. The names are this file's constants, never input. */
function list(blob: SQL, name: (typeof VALIDATION_LISTS)[number]): SQL {
  return sql`(${blob} -> ${sql.raw(`'${name}'`)})`;
}

/**
 * True when `blob` is an object holding all six lists as arrays, and every
 * `googleFeatures` entry holds `missingRequired` and `missingRecommended` as
 * arrays.
 *
 * Without it a blob missing a list would count as zero in `jsonb_array_length`'s
 * null and expand to no rows in `jsonb_array_elements`, and a feature entry
 * without its two lists would fail both counting filters — a malformed verdict
 * read as a clean one. The derivation writes only parsed `BlockValidation`s, so
 * a false here is a row this engine did not write, and the readers throw.
 */
export function validationReadable(blob: SQL): SQL {
  return sql`(jsonb_typeof(${blob}) = 'object' and ${sql.join(
    VALIDATION_LISTS.map((name) => sql`jsonb_typeof(${list(blob, name)}) = 'array'`),
    sql` and `,
  )} and not jsonb_path_exists(${blob}, ${sql.raw(`'${MALFORMED_FEATURE_ENTRY}'`)}))`;
}

/**
 * A `googleFeatures` entry that is not an object carrying both lists as arrays.
 * The `exists` clauses are not redundant: in lax mode a MISSING key yields an
 * empty sequence, whose `.type()` comparison is false, so without them an entry
 * lacking `missingRequired` would pass.
 */
const MALFORMED_FEATURE_ENTRY =
  'lax $.googleFeatures[*] ? (@.type() != "object"' +
  " || !exists(@.missingRequired) || !exists(@.missingRecommended)" +
  ' || @.missingRequired.type() != "array" || @.missingRecommended.type() != "array")';

/** One block's warnings (R0.8), null when the blob is unreadable. */
export function blockWarnings(blob: SQL): SQL {
  return sql`(jsonb_array_length(${list(blob, "unknownTypes")})
    + jsonb_array_length(${list(blob, "unknownProperties")})
    + jsonb_array_length(${list(blob, "typeMismatches")})
    + jsonb_array_length(jsonb_path_query_array(${blob},
        'strict $.googleFeatures[*] ? (@.missingRequired.size() > 0)')))`;
}

/** One block's infos (R0.8), null when the blob is unreadable. */
export function blockInfos(blob: SQL): SQL {
  return sql`(jsonb_array_length(${list(blob, "propertyStatus")})
    + jsonb_array_length(jsonb_path_query_array(${blob},
        'strict $.googleFeatures[*] ? (@.missingRecommended.size() > 0)'))
    + jsonb_array_length(${list(blob, "deprecatedFeatures")}))`;
}

/**
 * One block's problems as ONE jsonb array, each entry its list's own entry plus
 * `problem`, in `STRUCTURED_DATA_PROBLEMS` order and each list's own order.
 *
 * One array rather than a union of seven queries so `with ordinality` numbers
 * the block's rows once, from 1: that number is the view's second keyset part.
 * A Google feature entry missing both kinds is two rows, one per kind.
 */
export function blockProblems(blob: SQL): SQL {
  const tagged = (
    name: (typeof VALIDATION_LISTS)[number],
    problem: StructuredDataProblem,
    where: SQL | null = null,
  ): SQL => sql`coalesce((
      select jsonb_agg(e.entry || jsonb_build_object('problem', ${sql.raw(`'${problem}'`)}::text) order by e.n)
        from jsonb_array_elements(${list(blob, name)}) with ordinality as e(entry, n)
       ${where === null ? sql`` : sql`where ${where}`}
    ), '[]'::jsonb)`;
  return sql`(${sql.join(
    [
      tagged("unknownTypes", "unknown-type"),
      tagged("unknownProperties", "unknown-property"),
      tagged("propertyStatus", "property-status"),
      tagged("typeMismatches", "type-mismatch"),
      tagged("googleFeatures", "google-required", sql`jsonb_array_length(e.entry -> 'missingRequired') > 0`),
      tagged("googleFeatures", "google-recommended", sql`jsonb_array_length(e.entry -> 'missingRecommended') > 0`),
      tagged("deprecatedFeatures", "deprecated-feature"),
    ],
    sql` || `,
  )})`;
}

/** The list separator inside a cell — the CSV writer's own (`|`, src/api/csv.ts). */
const LIST_SEPARATOR = "|";

/**
 * Between the missing Google requirement LABELS in a google-* Detail cell — a
 * list of things that are ALL missing. Not `|`: a label that is itself a choice
 * is spelled with `|` ("offers.price | offers.priceSpecification.price | …",
 * google-features.ts), and the type-mismatch Detail uses `|` for "any of", so a
 * `|` here would make AND and OR one character. No label contains a comma
 * (pinned over `GOOGLE_FEATURES` in test/api/structured-data.test.ts).
 */
export const LABEL_SEPARATOR = ", ";

/** The view's cells for one problem entry: Path, Node Type, Problem, Detail. */
export interface ProblemCells {
  path: string;
  nodeType: string;
  problem: StructuredDataProblem;
  detail: string;
}

/**
 * A problem entry (one of `blockProblems`' array) as the view's four cells.
 *
 * The Detail is a short sentence a person reads in a spreadsheet, never the raw
 * JSON. An entry that is not the shape its `problem` names is a blob this engine
 * did not write: it throws naming the crawl and row rather than printing a blank.
 */
export function problemCells(entry: unknown, where: string): ProblemCells {
  const bad = (why: string): never => {
    throw new Error(`structured_data_nodes: ${where} holds a problem entry that ${why}`);
  };
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return bad("is not an object");
  const e = entry as Record<string, unknown>;
  const text = (key: string): string => {
    const value = e[key];
    return typeof value === "string" ? value : bad(`has no string '${key}'`);
  };
  const texts = (key: string): string[] => {
    const value = e[key];
    return Array.isArray(value) && value.every((v) => typeof v === "string")
      ? (value as string[])
      : bad(`has no string list '${key}'`);
  };
  const problem = text("problem");
  if (!(STRUCTURED_DATA_PROBLEMS as readonly string[]).includes(problem)) {
    return bad(`names an unknown problem '${problem}'`);
  }
  const path = text("path");
  switch (problem as StructuredDataProblem) {
    case "unknown-type":
      return { path, nodeType: text("type"), problem: "unknown-type", detail: `${text("type")} is not a schema.org type` };
    case "unknown-property":
      return {
        path,
        nodeType: text("type"),
        problem: "unknown-property",
        detail: `${text("property")} is not a property of ${text("type")}`,
      };
    case "property-status": {
      const status = text("status");
      const by = e["supersededBy"];
      if (by !== null && typeof by !== "string") return bad("has a supersededBy that is neither a string nor null");
      const detail =
        status === "pending"
          ? `${text("property")}: pending`
          : status === "superseded"
            ? `${text("property")}: superseded${by === null ? "" : ` by ${by}`}`
            : bad(`has an unknown status '${status}'`);
      // A property status entry is about the property, which the path's node holds; it names no type.
      return { path, nodeType: "", problem: "property-status", detail };
    }
    case "type-mismatch":
      return {
        path,
        nodeType: text("type"),
        problem: "type-mismatch",
        detail: `${text("property")}: ${text("type")} (expected ${texts("expected").join(LIST_SEPARATOR)})`,
      };
    case "google-required":
      return {
        path,
        nodeType: text("type"),
        problem: "google-required",
        detail: `${text("feature")}: ${texts("missingRequired").join(LABEL_SEPARATOR)}`,
      };
    case "google-recommended":
      return {
        path,
        nodeType: text("type"),
        problem: "google-recommended",
        detail: `${text("feature")}: ${texts("missingRecommended").join(LABEL_SEPARATOR)}`,
      };
    case "deprecated-feature":
      return { path, nodeType: text("type"), problem: "deprecated-feature", detail: text("feature") };
  }
}

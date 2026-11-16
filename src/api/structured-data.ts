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
 * the two it has, and each problem counts under its rule's severity:
 *  - a WARNING is an unknown type, an unknown property, a type mismatch, an
 *    empty value (`schema.empty-value`), and every JSON-LD parse error and
 *    microdata error on the page;
 *  - an INFO is a pending or superseded property, and a reference no block of
 *    the same page defines (`schema.unresolved-reference`). On a crawl not
 *    wholly at extraction 4 references are NOT counted, as the rule does not
 *    judge them there, and the listing names them in `notMeasured`
 *    (`UNRESOLVED_NOT_MEASURED`); the CSV view writes no such rows and its
 *    export answer carries the same `notMeasured`.
 *
 * Structured data is judged by the schema.org vocabulary and the JSON-LD,
 * Microdata and RDFa specs (29a rework); no search engine's profile decides
 * what is listed.
 */
import { sql, type SQL } from "drizzle-orm";

import type { StructuredDataFormat, StructuredDataSkips } from "../crawl/parse/page-analyzer.js";
import { V4 } from "../rules/query/page-facts.js";
import { staleBlob } from "../rules/schema-org/blob-sql.js";
import type { NotMeasured } from "./overview.js";
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

/** The `structured_data_nodes` view's `Problem` vocabulary, in the order a block's rows are written. */
export const STRUCTURED_DATA_PROBLEMS = [
  "unknown-type",
  "unknown-property",
  "property-status",
  "type-mismatch",
  "empty-value",
  "unresolved-reference",
] as const;
export type StructuredDataProblem = (typeof STRUCTURED_DATA_PROBLEMS)[number];

/** The `BlockValidation` lists the surface reads. A blob without all nine is unreadable. */
const VALIDATION_LISTS = [
  "cappedLists",
  "unknownTypes",
  "unknownProperties",
  "propertyStatus",
  "typeMismatches",
  "emptyValues",
  "definedIds",
  "references",
  "nodes",
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

/** A list of the blob, by name. The names are this file's constants, never input. */
function list(blob: SQL, name: (typeof VALIDATION_LISTS)[number]): SQL {
  return sql`(${blob} -> ${sql.raw(`'${name}'`)})`;
}

/**
 * Entries the surface reads by key, in a shape the validator does not write:
 *  - a `nodes` entry that is not an object carrying its path, type, flag and
 *    property list (the listing projects them);
 *  - a `references` entry without a string `id` (the counts compare it);
 *  - a `definedIds` entry that is not a string.
 * The `exists` clauses are not redundant: in lax mode a MISSING key yields an
 * empty sequence, whose `.type()` comparison is false, so without them an entry
 * lacking the key would pass.
 */
const MALFORMED_ENTRIES = [
  'lax $.nodes[*] ? (@.type() != "object" || !exists(@.path) || !exists(@."type")' +
    ' || !exists(@.propertiesCapped) || !exists(@.properties) || @.properties.type() != "array"' +
    ' || !exists(@.types) || @.types.type() != "array" || !exists(@.typesCapped))',
  'lax $.references[*] ? (@.type() != "object" || !exists(@.id) || @.id.type() != "string"' +
    ' || !exists(@.written) || @.written.type() != "string")',
  'lax $.definedIds[*] ? (@.type() != "string")',
];

/**
 * True when `blob` is an object holding all eight lists as arrays, and the
 * entries the surface reads by key are the shape the validator writes.
 *
 * Without it a blob missing a list would count as zero in `jsonb_array_length`'s
 * null and expand to no rows in `jsonb_array_elements` — a malformed verdict
 * read as a clean one. A blob written before the 29a rework (other lists, no
 * `nodes`) is one of these. The derivation writes only parsed
 * `BlockValidation`s, so a false here is a row this ruleset did not write, and
 * the readers throw.
 */
export function validationReadable(blob: SQL): SQL {
  return sql`(jsonb_typeof(${blob}) = 'object' and not ${staleBlob(blob)} and ${sql.join(
    VALIDATION_LISTS.map((name) => sql`jsonb_typeof(${list(blob, name)}) = 'array'`),
    sql` and `,
  )} and ${sql.join(
    MALFORMED_ENTRIES.map((path) => sql`not jsonb_path_exists(${blob}, ${sql.raw(`'${path}'`)})`),
    sql` and `,
  )})`;
}

/**
 * What a listing or export names when it does not count unresolved references:
 * the rule's own refusal (ruling R0.7), on a crawl not wholly at extraction 4.
 */
export const UNRESOLVED_NOT_MEASURED: NotMeasured[number] = {
  id: "schema.unresolved-reference",
  reason:
    "references are resolved only on a crawl wholly at extraction version 4: below it, " +
    "microdata and RDFa blocks that may define the id were never read",
};

/**
 * True when every page of the crawl was written by extraction 4 or later —
 * `v4Gate`'s question, asked in SQL so the listing and the CSV answer it in the
 * statement that counts (an uncorrelated subquery, evaluated once).
 */
export function referencesMeasured(crawlId: string): SQL {
  return sql`not exists (
    select 1 from pages px
     where px.crawl_id = ${crawlId}
       and (px.extraction_version is null or px.extraction_version < ${V4}))`;
}

/**
 * True for a reference entry `ref` (jsonb) whose id no block of the page
 * `pageId` defines — what makes a reference an `unresolved-reference`. Per PAGE,
 * not per block: a graph split over two scripts is one graph, so a sibling
 * block's definition resolves it. The same test `schema.unresolved-reference`
 * applies, under the same gate: never true on a crawl not wholly at
 * extraction 4 (`referencesMeasured`). Ids are stored resolved against the
 * page (validate.ts), so the comparison is of strings.
 */
function unresolved(ref: SQL, crawlId: string, pageId: SQL): SQL {
  return sql`${referencesMeasured(crawlId)} and not exists (
    select 1 from structured_data d
     where d.crawl_id = ${crawlId} and d.page_id = ${pageId}
       and d.validation_jsonb -> 'definedIds' @> jsonb_build_array(${ref} -> 'id'))`;
}

/**
 * Whether one block cut a list the counts read (`cappedLists`, final review
 * I1): the page's counts are then short, and the row says so
 * (`problemsCapped`). `references` counts only where references are measured.
 */
export function blockProblemsCapped(blob: SQL, crawlId: string): SQL {
  return sql`exists (
    select 1 from jsonb_array_elements_text(${list(blob, "cappedLists")}) as c(name)
     where c.name in ('unknownTypes', 'unknownProperties', 'propertyStatus', 'typeMismatches', 'emptyValues')
        or (c.name = 'references' and ${referencesMeasured(crawlId)}))`;
}

/**
 * Every type a block's top-level node states (`nodes[].types`), joined with
 * the CSV list separator — the CSV view's Schema Type (final review I2).
 */
export function blockTypesCell(blob: SQL): SQL {
  return sql`(select coalesce(string_agg(t.type, ${LIST_SEPARATOR}::text order by n.ord, t.ord), '')
      from jsonb_array_elements(${list(blob, "nodes")}) with ordinality as n(node, ord)
      cross join lateral jsonb_array_elements_text(n.node -> 'types') with ordinality as t(type, ord))`;
}

/** One block's warnings (R0.8), null when the blob is unreadable. */
export function blockWarnings(blob: SQL): SQL {
  return sql`(jsonb_array_length(${list(blob, "unknownTypes")})
    + jsonb_array_length(${list(blob, "unknownProperties")})
    + jsonb_array_length(${list(blob, "typeMismatches")})
    + jsonb_array_length(${list(blob, "emptyValues")}))`;
}

/**
 * One block's infos (R0.8): its pending or superseded properties and its
 * references no block of the page defines. Null when the blob is unreadable.
 */
export function blockInfos(blob: SQL, crawlId: string, pageId: SQL): SQL {
  return sql`(jsonb_array_length(${list(blob, "propertyStatus")})
    + (select count(*) from jsonb_array_elements(${list(blob, "references")}) as r(ref)
        where ${unresolved(sql`r.ref`, crawlId, pageId)}))`;
}

/**
 * One block's problems as ONE jsonb array, each entry its list's own entry plus
 * `problem`, in `STRUCTURED_DATA_PROBLEMS` order and each list's own order.
 *
 * One array rather than a union of six queries so `with ordinality` numbers
 * the block's rows once, from 1: that number is the view's second keyset part.
 * A reference is a problem only when no block of the page defines its id
 * (`unresolved`): the view's row is per block, and the page-level SQL check is
 * what lets it agree with the listing's count and with the rule.
 */
export function blockProblems(blob: SQL, crawlId: string, pageId: SQL): SQL {
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
      tagged("emptyValues", "empty-value"),
      tagged("references", "unresolved-reference", unresolved(sql`e.entry`, crawlId, pageId)),
    ],
    sql` || `,
  )})`;
}

/** The list separator inside a cell — the CSV writer's own (`|`, src/api/csv.ts). */
const LIST_SEPARATOR = "|";

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
    case "empty-value": {
      // The type of the node holding the value; null when that node is untyped.
      const type = e["type"];
      if (type !== null && typeof type !== "string") return bad("has a type that is neither a string nor null");
      return { path, nodeType: type ?? "", problem: "empty-value", detail: `${text("property")} is empty` };
    }
    case "unresolved-reference": {
      // A bare reference has no type of its own; the id is the whole of it —
      // as written, and as resolved against the page when that differs.
      const id = text("id");
      const written = text("written");
      return {
        path,
        nodeType: "",
        problem: "unresolved-reference",
        detail: `${written === id ? id : `${written} (${id})`} is not defined on this page`,
      };
    }
  }
}

/** One top-level node of a page, as the listing names it (Talos obligation 6: named fields). */
export interface StructuredDataNode {
  format: StructuredDataFormat;
  path: string;
  /** The primary type, as the markup states it; a name outside the schema.org vocabulary included. Null when untyped. */
  type: string | null;
  /**
   * Every type the node states, in authored order (`[]` when untyped). A
   * microdata or RDFa node lists one: extraction 4 keeps only the first
   * itemtype / typeof token. Capped per node (`typesCapped`).
   */
  types: string[];
  typesCapped: boolean;
  /** The node's property names, capped per node (`propertiesCapped`). */
  properties: string[];
  propertiesCapped: boolean;
}

/**
 * The page's `nodes` jsonb array (built in SQL from readable blobs, in block
 * order) projected key by key. Anything but the shape the listing built is a
 * row this engine did not write, and throws naming the crawl and page.
 */
export function projectNodes(value: unknown, crawlId: string, url: string): StructuredDataNode[] {
  const bad = (why: string): never => {
    throw new Error(`crawl ${crawlId}, page ${url}: a structured-data node ${why}`);
  };
  if (!Array.isArray(value)) return bad("list is not an array");
  return value.map((entry: unknown): StructuredDataNode => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return bad("is not an object");
    const e = entry as Record<string, unknown>;
    const format = typeof e["format"] === "string" ? storedFormat(e["format"], crawlId, url) : bad("has no format");
    const path = typeof e["path"] === "string" ? e["path"] : bad("has no string path");
    const type = e["type"];
    if (type !== null && typeof type !== "string") return bad("has a type that is neither a string nor null");
    const types = e["types"];
    if (!Array.isArray(types) || !types.every((t) => typeof t === "string")) return bad("has no string list of types");
    const typesCapped = e["typesCapped"];
    if (typeof typesCapped !== "boolean") return bad("has no boolean typesCapped");
    const properties = e["properties"];
    if (!Array.isArray(properties) || !properties.every((p) => typeof p === "string")) {
      return bad("has no string list of properties");
    }
    const capped = e["propertiesCapped"];
    if (typeof capped !== "boolean") return bad("has no boolean propertiesCapped");
    return {
      format,
      path,
      type,
      types: types as string[],
      typesCapped,
      properties: properties as string[],
      propertiesCapped: capped,
    };
  });
}

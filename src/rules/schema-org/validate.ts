/**
 * The node validator: one stored structured-data block in, one
 * `BlockValidation` out. Pure — no database, no fetch (hard rule 2).
 *
 * The block is a JSON-LD node as authored (any `@type` spelling, `@context` on
 * the block), or a microdata/RDFa node the analyzer wrote in the same shape.
 * Every node in it is walked once; a typed `@graph` container is judged as its
 * own node and its `@graph` member is not walked, because the analyzer stored
 * each member as a block of its own.
 *
 * **Which names are schema.org (R0.5).** The block's top-level `@context` is
 * read once:
 *  - absent, null, a schema.org URL (http/https, with or without www or a
 *    trailing slash, or schema.org's own context document), or an object whose
 *    `@vocab` is one of those → bare names are schema.org and the block is
 *    judged. In an array the last entry that sets a vocabulary wins; an object
 *    without `@vocab` (`{"@language": "en"}`, term definitions) sets none.
 *  - anything else → the block is wholly outside the vocabulary: counted in
 *    `outsideVocabulary`, never judged.
 * A context nested inside the block is not read.
 *
 * **`outsideVocabulary` counts what was not judged:**
 *  - in a wholly-outside block, 1 per node (every object in the tree except a
 *    JSON-LD value object `{"@value": …}`) plus 1 per non-`@` property key on it;
 *  - in a judged block, 1 per `@type` entry that is not a schema.org name
 *    (another IRI or prefix, or a non-string) plus 1 per property key that is
 *    not a schema.org name.
 *
 * **Per node** (types resolved through `schemaOrgName`):
 *  - a schema.org name the vocabulary does not know (and that is not a DataType
 *    such as `Text`) → `unknownTypes`;
 *  - an untyped node (no `@type`, or only `@type` entries that are not
 *    schema.org names) is not judged; only its values are walked, so a typed
 *    node inside it is;
 *  - each property of a typed node: not in the vocabulary, or not applicable to
 *    the node's known types → `unknownProperties` (skipped when the node has no
 *    known type, so one mistyped `@type` does not turn every property into a
 *    finding); pending or superseded → `propertyStatus`; a nested node with a
 *    known type the property's range refuses → `typeMismatches`. Strings and
 *    numbers are never judged against a range.
 *
 * **Standards facts (29a rework).** Recorded in every block, judged or wholly
 * outside the vocabulary, because they are facts about the markup's syntax
 * (the JSON-LD, Microdata and RDFa specs) rather than about schema.org:
 *  - `emptyValues`: each property value that is empty markup (`isEmptyValue`,
 *    values.ts), at its own path — `offers: {price: ""}` is `$.offers.price`,
 *    `sameAs: ["", x]` is `$.sameAs[0]` — with the type of the node holding it
 *    (null when that node is untyped) and the property's name;
 *  - `definedIds`: the `@id` of every node that carries anything besides it,
 *    each once. NEVER capped: a defined id dropped for want of room would turn
 *    every reference to it into a false "unresolved" (the block's stored size,
 *    `MAX_LD_JSON_CHARS` in the analyzer, bounds it);
 *  - `references`: every bare `{"@id": …}` (`bareReferenceId`) with its path.
 *    Whether it resolves is a question about the PAGE — another block may
 *    define the id — so it is answered at rules time, not here;
 *  - `nodes`: the block's top-level node — the analyzer stores each `@graph`
 *    member as a block of its own, so a member is a top-level node too — with
 *    its type (the primary known type, else the first stated `@type` as
 *    written, schema.org spellings reduced to the bare name; null when untyped),
 *    its property names (keys without `@` keywords, by schema.org name, each
 *    once, in authored order, capped at `MAX_PROBLEMS_PER_LIST` with
 *    `propertiesCapped` and `listsCapped` set), and which of the listed
 *    properties carry no non-empty value (`carriesValue`).
 *
 * Paths: `$` is the block, then `.prop` (or `["prop"]` for a key that is not an
 * identifier) and `[i]` where the value is an array, e.g. `$.offers[0].seller`.
 */
import { z } from "zod";

import { MAX_LD_JSON_NESTING } from "../../crawl/parse/page-analyzer.js";
import { schemaOrgName } from "../../crawl/parse/schema-names.js";
import { bareReferenceId, carriesValue, definedId, isEmptyValue } from "./values.js";
import {
  isDataType,
  isKnownType,
  isSubtypeOf,
  propertyAppliesTo,
  propertyDef,
  rangeAccepts,
} from "./vocabulary.js";

/** Each problem list stops here and sets `listsCapped`. */
export const MAX_PROBLEMS_PER_LIST = 50;

const path = z.string().min(1);
const list = <T extends z.ZodType>(entry: T) => z.array(entry).max(MAX_PROBLEMS_PER_LIST);

/** What readers parse a stored `validation_jsonb` blob with. */
export const blockValidationSchema = z.strictObject({
  topType: z.string().nullable(),
  unknownTypes: list(z.strictObject({ path, type: z.string() })),
  unknownProperties: list(z.strictObject({ path, type: z.string(), property: z.string() })),
  propertyStatus: list(
    z.strictObject({
      path,
      property: z.string(),
      status: z.enum(["pending", "superseded"]),
      supersededBy: z.string().nullable(),
    }),
  ),
  typeMismatches: list(
    z.strictObject({ path, property: z.string(), type: z.string(), expected: z.array(z.string()) }),
  ),
  emptyValues: list(z.strictObject({ path, type: z.string().nullable(), property: z.string() })),
  // Not capped, by design: see the header.
  definedIds: z.array(z.string().min(1)),
  references: list(z.strictObject({ path, id: z.string().min(1) })),
  nodes: list(
    z.strictObject({
      path,
      type: z.string().nullable(),
      properties: z.array(z.string()).max(MAX_PROBLEMS_PER_LIST),
      emptyProperties: z.array(z.string()).max(MAX_PROBLEMS_PER_LIST),
      propertiesCapped: z.boolean(),
    }),
  ),
  outsideVocabulary: z.number().int().nonnegative(),
  listsCapped: z.boolean(),
});

export type BlockValidation = z.infer<typeof blockValidationSchema>;

type Lists = Omit<BlockValidation, "topType" | "definedIds" | "outsideVocabulary" | "listsCapped">;

const SCHEMA_ORG_VOCAB =
  /^https?:\/\/(?:www\.)?schema\.org(?:\/|\/docs\/jsonldcontext\.jsonld?)?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the block's top-level `@context` makes bare names schema.org (see the header). */
function judgedContext(context: unknown): boolean {
  if (context === undefined) return true;
  // null in JSON-LD resets the active context: no vocabulary is set.
  let vocab: string | null = null;
  for (const entry of Array.isArray(context) ? context : [context]) {
    if (entry === null) vocab = null;
    else if (typeof entry === "string") vocab = entry;
    else if (isRecord(entry)) {
      if (!("@vocab" in entry)) continue;
      const v = entry["@vocab"];
      if (v === null) vocab = null;
      else if (typeof v === "string") vocab = v;
      else return false; // a malformed @vocab names no vocabulary we know
    } else return false; // a number or boolean is not a context
  }
  return vocab === null || SCHEMA_ORG_VOCAB.test(vocab.trim());
}

function keyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/** The most specific of the known types (one no other known type descends from), first in authored order. */
function primaryType(known: readonly string[]): string | null {
  return known.find((t) => !known.some((u) => u !== t && isSubtypeOf(u, t))) ?? null;
}

/** What a property value sits under: the holding node's type and the property's name. */
interface Site {
  type: string | null;
  property: string;
}

/** The first `@type` entry as written, a schema.org spelling reduced to its bare name; null when untyped. */
function statedType(node: Record<string, unknown>): string | null {
  const raw = node["@type"];
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    if (typeof entry === "string" && entry.trim() !== "") return schemaOrgName(entry) ?? entry;
  }
  return null;
}

/** A property key's name: its schema.org name in any spelling, else the key as written. */
function propertyName(key: string): string {
  return schemaOrgName(key) ?? key;
}

class Walker {
  readonly lists: Lists = {
    unknownTypes: [],
    unknownProperties: [],
    propertyStatus: [],
    typeMismatches: [],
    emptyValues: [],
    references: [],
    nodes: [],
  };
  /** Insertion-ordered and deduplicated; never capped (see the header). */
  readonly definedIds = new Set<string>();
  outside = 0;
  capped = false;

  constructor(private readonly judged: boolean) {}

  private push<K extends keyof Lists>(key: K, entry: Lists[K][number]): void {
    const target = this.lists[key] as Lists[K][number][];
    if (target.length >= MAX_PROBLEMS_PER_LIST) {
      this.capped = true;
      return;
    }
    target.push(entry);
  }

  /**
   * The node's known schema.org types, after recording unknown and outside
   * ones; null when the node is untyped for this walk — no `@type`, or no
   * `@type` entry that is a schema.org name at all (a node typed only in
   * another vocabulary, e.g. `http://data-vocabulary.org/Breadcrumb`, is
   * walked like an untyped one).
   */
  private resolveTypes(node: Record<string, unknown>, path: string): string[] | null {
    if (!("@type" in node)) return null;
    const raw = node["@type"];
    const known: string[] = [];
    let schemaNamed = false;
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      const name = typeof entry === "string" ? schemaOrgName(entry) : null;
      if (name === null) {
        this.outside += 1;
        continue;
      }
      schemaNamed = true;
      if (isKnownType(name)) known.push(name);
      else if (!isDataType(name)) this.push("unknownTypes", { path, type: name });
    }
    return schemaNamed ? known : null;
  }

  /**
   * The block's top-level node, as `nodes` lists it: its property names by
   * schema.org name, each once in authored order, capped, and which of the
   * listed ones carry no non-empty value.
   */
  private topLevel(node: Record<string, unknown>, type: string | null): void {
    const carried = new Map<string, boolean>();
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@")) continue;
      const name = propertyName(key);
      carried.set(name, (carried.get(name) ?? false) || carriesValue(value));
    }
    const all = [...carried.keys()];
    const properties = all.slice(0, MAX_PROBLEMS_PER_LIST);
    const propertiesCapped = all.length > properties.length;
    if (propertiesCapped) this.capped = true;
    this.push("nodes", {
      path: "$",
      type,
      properties,
      emptyProperties: properties.filter((name) => carried.get(name) !== true),
      propertiesCapped,
    });
  }

  /**
   * Walks a node; returns its primary known type. `parentKnown` is the known
   * types of the node whose property holds this one (empty at the root and
   * under an untyped node).
   */
  node(
    node: Record<string, unknown>,
    path: string,
    depth: number,
    parentKnown: readonly string[],
  ): string | null {
    if (depth > MAX_LD_JSON_NESTING) {
      throw new Error(
        `validateBlock: nodes nested deeper than ${MAX_LD_JSON_NESTING} at ${path} — ` +
          "the analyzer never stores such a block",
      );
    }
    const id = definedId(node);
    if (id !== null) this.definedIds.add(id);

    if (!this.judged) {
      const type = statedType(node);
      if (path === "$") this.topLevel(node, type);
      this.outside += 1;
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("@")) continue;
        this.outside += 1;
        this.value(value, keyPath(path, key), depth, null, [], { type, property: propertyName(key) });
      }
      return null;
    }

    const known = this.resolveTypes(node, path);
    const typed = known !== null;
    const primary = typed ? primaryType(known) : null;
    const type = primary ?? statedType(node);
    if (path === "$") this.topLevel(node, type);

    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@")) continue;
      const childPath = keyPath(path, key);
      const name = schemaOrgName(key);
      const site: Site = { type, property: name ?? key };
      if (name === null) this.outside += 1;
      if (name === null || !typed) {
        this.value(value, childPath, depth, null, known ?? [], site);
        continue;
      }
      const def = propertyDef(name);
      if (primary !== null && (def === undefined || !propertyAppliesTo(name, known))) {
        this.push("unknownProperties", { path, type: primary, property: name });
      }
      if (def?.status !== undefined) {
        this.push("propertyStatus", {
          path,
          property: name,
          status: def.status,
          supersededBy: def.supersededBy ?? null,
        });
      }
      this.value(value, childPath, depth, def === undefined ? null : name, known, site);
    }
    return primary;
  }

  /**
   * Walks a property value; `rangeOf` names the property whose range a nested
   * node is judged against, `site` the node and property the value sits under.
   * An empty value and a bare reference are recorded and end the walk there.
   */
  private value(
    value: unknown,
    path: string,
    depth: number,
    rangeOf: string | null,
    parentKnown: readonly string[],
    site: Site,
  ): void {
    if (isEmptyValue(value)) {
      this.push("emptyValues", { path, type: site.type, property: site.property });
      return;
    }
    const reference = bareReferenceId(value);
    if (reference !== null) {
      this.push("references", { path, id: reference });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) =>
        this.value(entry, `${path}[${i}]`, depth, rangeOf, parentKnown, site),
      );
      return;
    }
    if (!isRecord(value)) return;
    // A JSON-LD value object is a literal, not a node.
    if ("@value" in value) return;
    // A list or set container holds the values themselves.
    for (const container of ["@list", "@set"] as const) {
      if (container in value) {
        this.value(value[container], path, depth, rangeOf, parentKnown, site);
        return;
      }
    }
    const nestedType = this.node(value, path, depth + 1, parentKnown);
    if (rangeOf !== null && nestedType !== null) {
      const types = typesOf(value);
      if (!rangeAccepts(rangeOf, types)) {
        this.push("typeMismatches", {
          path,
          property: rangeOf,
          type: nestedType,
          expected: [...propertyDef(rangeOf)!.range].sort(),
        });
      }
    }
  }
}

/** The schema.org names of a node's `@type` entries (known or not). */
function typesOf(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  return (Array.isArray(raw) ? raw : [raw])
    .map((t) => (typeof t === "string" ? schemaOrgName(t) : null))
    .filter((t): t is string => t !== null);
}

/** Validate one stored structured-data block. Throws on a block that is not a JSON object. */
export function validateBlock(raw: unknown): BlockValidation {
  if (!isRecord(raw)) {
    throw new Error(
      `validateBlock: a stored block must be a JSON object, got ${Array.isArray(raw) ? "an array" : typeof raw}`,
    );
  }
  const walker = new Walker(judgedContext(raw["@context"]));
  const topType = walker.node(raw, "$", 1, []);
  return {
    topType,
    unknownTypes: walker.lists.unknownTypes,
    unknownProperties: walker.lists.unknownProperties,
    propertyStatus: walker.lists.propertyStatus,
    typeMismatches: walker.lists.typeMismatches,
    emptyValues: walker.lists.emptyValues,
    definedIds: [...walker.definedIds],
    references: walker.lists.references,
    nodes: walker.lists.nodes,
    outsideVocabulary: walker.outside,
    listsCapped: walker.capped,
  };
}

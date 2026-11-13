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
 *    numbers are never judged against a range;
 *  - Google features (`google-features.ts`) match by hierarchy: a subtype of a
 *    feature's type matches it. A nested Review / AggregateRating matches only
 *    under a parent whose known types are reviewable (`REVIEWABLE_PARENTS`).
 *    Withdrawn features (`deprecatedFeatures`) match the deprecated type
 *    EXACTLY, never its subtypes: Recipe is a schema.org subtype of HowTo, and
 *    Recipe rich results are alive.
 *
 * Paths: `$` is the block, then `.prop` (or `["prop"]` for a key that is not an
 * identifier) and `[i]` where the value is an array, e.g. `$.offers[0].seller`.
 */
import { z } from "zod";

import { MAX_LD_JSON_NESTING } from "../../crawl/parse/page-analyzer.js";
import { schemaOrgName } from "../../crawl/parse/schema-names.js";
import { DEPRECATED_FEATURES, GOOGLE_FEATURES } from "./google-features.js";
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
const featureId = z.enum(GOOGLE_FEATURES.map((f) => f.id) as [string, ...string[]]);
const deprecatedId = z.enum(DEPRECATED_FEATURES.map((f) => f.id) as [string, ...string[]]);

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
  googleFeatures: list(
    z.strictObject({
      feature: featureId,
      path,
      type: z.string(),
      missingRequired: z.array(z.string()),
      missingRecommended: z.array(z.string()),
    }),
  ),
  deprecatedFeatures: list(z.strictObject({ feature: deprecatedId, path, type: z.string() })),
  outsideVocabulary: z.number().int().nonnegative(),
  listsCapped: z.boolean(),
});

export type BlockValidation = z.infer<typeof blockValidationSchema>;

type Lists = Omit<BlockValidation, "topType" | "outsideVocabulary" | "listsCapped">;

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

class Walker {
  readonly lists: Lists = {
    unknownTypes: [],
    unknownProperties: [],
    propertyStatus: [],
    typeMismatches: [],
    googleFeatures: [],
    deprecatedFeatures: [],
  };
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
    if (!this.judged) {
      this.outside += 1;
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("@")) continue;
        this.outside += 1;
        this.value(value, keyPath(path, key), depth, null, []);
      }
      return null;
    }

    const known = this.resolveTypes(node, path);
    const typed = known !== null;
    const primary = typed ? primaryType(known) : null;
    if (typed && known.length > 0) this.features(node, path, known, parentKnown);

    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@")) continue;
      const childPath = keyPath(path, key);
      const name = schemaOrgName(key);
      if (name === null) this.outside += 1;
      if (name === null || !typed) {
        this.value(value, childPath, depth, null, known ?? []);
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
      this.value(value, childPath, depth, def === undefined ? null : name, known);
    }
    return primary;
  }

  /** Walks a property value; `rangeOf` names the property whose range a nested node is judged against. */
  private value(
    value: unknown,
    path: string,
    depth: number,
    rangeOf: string | null,
    parentKnown: readonly string[],
  ): void {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => this.value(entry, `${path}[${i}]`, depth, rangeOf, parentKnown));
      return;
    }
    if (!isRecord(value)) return;
    // A JSON-LD value object is a literal, not a node.
    if ("@value" in value) return;
    // A list or set container holds the values themselves.
    for (const container of ["@list", "@set"] as const) {
      if (container in value) {
        this.value(value[container], path, depth, rangeOf, parentKnown);
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

  private features(
    node: Record<string, unknown>,
    path: string,
    known: readonly string[],
    parentKnown: readonly string[],
  ): void {
    const nested = path !== "$";
    const matched: { id: string; type: string; feature: (typeof GOOGLE_FEATURES)[number] }[] = [];
    for (const feature of GOOGLE_FEATURES) {
      if (feature.depth === "top" && nested) continue;
      // A nested match needs a parent the feature reads (REVIEWABLE_PARENTS).
      if (
        nested &&
        feature.nestedUnder !== undefined &&
        !parentKnown.some((p) => feature.nestedUnder!.some((t) => isSubtypeOf(p, t)))
      ) {
        continue;
      }
      const type = known.find((k) => feature.appliesTo.some((a) => isSubtypeOf(k, a)));
      if (type === undefined) continue;
      if (feature.applies !== undefined && !feature.applies(node)) continue;
      matched.push({ id: feature.id, type, feature });
    }
    const ids = new Set(matched.map((m) => m.id));
    for (const { feature, type } of matched) {
      if (feature.skipWhen?.some((id) => ids.has(id))) continue;
      const ctx = { nested };
      this.push("googleFeatures", {
        feature: feature.id,
        path,
        type,
        missingRequired: feature.required.filter((r) => !r.met(node, ctx)).map((r) => r.label),
        missingRecommended: feature.recommended.filter((r) => !r.met(node, ctx)).map((r) => r.label),
      });
    }
    for (const deprecated of DEPRECATED_FEATURES) {
      // Exact, not by hierarchy: Recipe is a subtype of HowTo and is not withdrawn.
      const type = known.find((k) => k === deprecated.type);
      if (type !== undefined) this.push("deprecatedFeatures", { feature: deprecated.id, path, type });
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
    ...walker.lists,
    outsideVocabulary: walker.outside,
    listsCapped: walker.capped,
  };
}

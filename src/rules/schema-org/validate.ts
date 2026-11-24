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
 *  - `definedIds`: the `@id` of every node that carries a `@type` or a
 *    property, each once. NEVER capped: a defined id dropped for want of room
 *    would turn every reference to it into a false "unresolved" (the block's
 *    stored size, `MAX_LD_JSON_CHARS` in the analyzer, bounds it);
 *  - `references`: every bare `{"@id": …}` (`bareReferenceId`) with its path,
 *    the id resolved (`id`) and as written (`written`). Whether it resolves is
 *    a question about the PAGE — another block may define the id — so it is
 *    answered at rules time, not here;
 *  - `unresolved` / `unresolvedCount` (29d): the references no node of this
 *    block defines (the page's other blocks may) as resolved ids, one per
 *    reference, in walk order, and their count. NEVER capped, like
 *    `definedIds`: taken from every reference walked, so one past the 50th
 *    that `references` had no room for is found, and the page-level answer
 *    (which of them another block defines) is exact.
 *
 * **Ids are IRIs, resolved against the document base** (JSON-LD 1.1 §IRIs, as
 * microdata `itemid` and RDFa `resource` already are at extraction): the page
 * URL, or a `@base` the block's top-level `@context` declares (itself resolved
 * against the page; `null` removes the base). Both `definedIds` and
 * `references` hold resolved ids, so `#org` and `https://page#org` are one
 * node. A blank-node id (`_:b0`) is left as it is; an id that is not an IRI
 * reference, or a relative id with no base, stays as written — the extractor's
 * own rule for an unresolvable `itemid`. A `@base` in a nested context is not
 * read, as a nested `@vocab` is not. `<base href>` is honoured by no format.
 *  - `nodes`: the block's top-level node — the analyzer stores each `@graph`
 *    member as a block of its own, so a member is a top-level node too, unless
 *    it holds only an `@id`, which makes the block a bare reference at `$`, not a
 *    node (final review M2) — with
 *    its type (the primary known type, else the first stated `@type` as
 *    written, schema.org spellings reduced to the bare name; null when untyped),
 *    every type it states (`types`, authored order, same spellings; `[]` when
 *    untyped — a microdata or RDFa node states one, since extraction 4 keeps
 *    only the first itemtype / typeof token; capped at `MAX_PROBLEMS_PER_LIST`
 *    with `typesCapped` and `listsCapped` set),
 *    its property names (keys without `@` keywords, by schema.org name, each
 *    once, SORTED (the stored block is jsonb, which keeps no key order, so an
 *    "authored order" would be Postgres's), capped at `MAX_PROBLEMS_PER_LIST` with
 *    `propertiesCapped` and `listsCapped` set), and which of the listed
 *    properties carry no non-empty value (`carriesValue`).
 *
 * Paths: `$` is the block, then `.prop` (or `["prop"]` for a key that is not an
 * identifier) and `[i]` where the value is an array, e.g. `$.offers[0].seller`.
 */
import { z } from "zod";

import { MAX_LD_JSON_NESTING } from "../../crawl/parse/page-analyzer.js";
import { schemaOrgName } from "../../crawl/parse/schema-names.js";
import { resolveUrl } from "../../crawl/parse/item-core.js";
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

/** The problem and fact lists of a verdict, by name — what `cappedLists` may hold. */
const LIST_NAMES = [
  "unknownTypes",
  "unknownProperties",
  "propertyStatus",
  "typeMismatches",
  "emptyValues",
  "references",
  "nodes",
] as const;
export type ListName = (typeof LIST_NAMES)[number];
const list = <T extends z.ZodType>(entry: T) => z.array(entry).max(MAX_PROBLEMS_PER_LIST);

/** The block verdict's shape, before the count invariant (`blockValidationSchema`); readers parse with that. */
export const blockValidationObject = z.strictObject({
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
  // `id` resolved against the document base (the compared value); `written` as authored.
  references: list(z.strictObject({ path, id: z.string().min(1), written: z.string().min(1) })),
  /**
   * The resolved id of every reference no node of THIS block defines, one per
   * reference, in walk order (29d). NEVER capped, like `definedIds` (the block's
   * stored size bounds it): the page may define an id in another block, and the
   * rule can only subtract those from a complete list. `unresolvedCount` is its
   * length (`blockValidationSchema` enforces it).
   */
  unresolved: z.array(z.string().min(1)),
  unresolvedCount: z.number().int().nonnegative(),
  nodes: list(
    z.strictObject({
      path,
      type: z.string().nullable(),
      types: z.array(z.string()).max(MAX_PROBLEMS_PER_LIST),
      typesCapped: z.boolean(),
      properties: z.array(z.string()).max(MAX_PROBLEMS_PER_LIST),
      emptyProperties: z.array(z.string()).max(MAX_PROBLEMS_PER_LIST),
      propertiesCapped: z.boolean(),
    }),
  ),
  outsideVocabulary: z.number().int().nonnegative(),
  listsCapped: z.boolean(),
  /**
   * The lists that stopped at `MAX_PROBLEMS_PER_LIST`, each once, in the order
   * they were cut — so a reader of one list knows ITS count is short
   * (`problemsCapped`), not only that something on the block was cut.
   */
  cappedLists: z.array(z.enum(LIST_NAMES)),
  /**
   * Whether the block was judged against schema.org: its top-level `@context`
   * makes bare names schema.org names. False for a block wholly in another
   * vocabulary, whose names are counted in `outsideVocabulary`.
   */
  judged: z.boolean(),
});

/** `unresolvedCount` is the length of `unresolved`: the one invariant between the two. */
export const unresolvedCountMatches = (v: { unresolved: readonly string[]; unresolvedCount: number }): boolean =>
  v.unresolvedCount === v.unresolved.length;
export const UNRESOLVED_COUNT_ISSUE = { message: "unresolvedCount must equal the length of unresolved", path: ["unresolvedCount"] };

/** What readers parse a stored `validation_jsonb` blob with. */
export const blockValidationSchema = blockValidationObject.refine(unresolvedCountMatches, UNRESOLVED_COUNT_ISSUE);

export type BlockValidation = z.infer<typeof blockValidationObject>;

type Lists = Pick<BlockValidation, ListName>;

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

/**
 * Every type a node states, in authored order, each once: a schema.org spelling
 * reduced to the bare name (`statedType`'s rule), anything else as written.
 * `[]` for an untyped node. A node typed A and B is an A node and a B node, so
 * the facts list both (29a rework gate fix); `type` stays the primary one.
 */
function statedTypes(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  const out = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    if (typeof entry === "string" && entry.trim() !== "") out.add(schemaOrgName(entry) ?? entry);
  }
  return [...out];
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
  /**
   * The resolved id of every reference walked, in order, uncapped: whether one
   * is defined is known only when the walk ends. Bounded by the block's stored
   * size (`MAX_LD_JSON_CHARS`), as `definedIds` is.
   */
  readonly referenceIds: string[] = [];
  /** The lists that were cut, in the order they were (`cappedLists`). */
  readonly cappedLists = new Set<ListName>();
  outside = 0;
  capped = false;

  constructor(
    readonly judged: boolean,
    /** The document base ids resolve against; null when the block's context removed it. */
    private readonly base: string | null,
  ) {}

  /** An `@id` as an IRI: resolved against the base, a blank node as it is (see the header). */
  private resolveId(id: string): string {
    if (id.startsWith("_:")) return id;
    if (this.base !== null) return resolveUrl(id, this.base);
    try {
      return new URL(id).href;
    } catch {
      // Relative, with no base to resolve against: as written.
      return id;
    }
  }

  private push<K extends keyof Lists>(key: K, entry: Lists[K][number]): void {
    const target = this.lists[key] as Lists[K][number][];
    if (target.length >= MAX_PROBLEMS_PER_LIST) {
      this.capped = true;
      this.cappedLists.add(key);
      return;
    }
    target.push(entry);
  }

  /** Record a bare reference: always in `referenceIds`, in `references` while it has room. */
  private reference(path: string, written: string): void {
    const id = this.resolveId(written);
    this.referenceIds.push(id);
    this.push("references", { path, id, written });
  }

  /**
   * A block that is only a reference (`{"@id": …}`, its `@context` aside): an
   * `@graph` member the analyzer stored as a block of its own. It is checked
   * as the bare reference it is, at `$`, and is not a node (final review M2).
   */
  rootReference(id: string): void {
    this.reference("$", id);
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
   * schema.org name, each once, sorted, capped, and which of the
   * listed ones carry no non-empty value.
   */
  private topLevel(node: Record<string, unknown>, type: string | null): void {
    // Capped like the property list (Review Focus 5), the cut recorded. No
    // per-string cap: each name is a string of the stored block, whose size
    // the analyzer bounds (`MAX_LD_JSON_CHARS`), as it bounds property names.
    const stated = statedTypes(node);
    const types = stated.slice(0, MAX_PROBLEMS_PER_LIST);
    const typesCapped = stated.length > types.length;
    if (typesCapped) this.capped = true;
    const carried = new Map<string, boolean>();
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@")) continue;
      const name = propertyName(key);
      carried.set(name, (carried.get(name) ?? false) || carriesValue(value));
    }
    const all = [...carried.keys()].sort();
    const properties = all.slice(0, MAX_PROBLEMS_PER_LIST);
    const propertiesCapped = all.length > properties.length;
    if (propertiesCapped) this.capped = true;
    this.push("nodes", {
      path: "$",
      type,
      types,
      typesCapped,
      properties,
      emptyProperties: properties.filter((name) => carried.get(name) !== true),
      propertiesCapped,
    });
  }

  /**
   * Walks a node; returns its primary known type. `parentKnown` is the known
   * types of the node whose property holds this one (empty at the root and
   * under an untyped node). `heldBy` is the schema.org property that holds
   * this node (null at the root, or when that property is not in the
   * vocabulary): a Role may repeat it, which is schema.org's Role pattern
   * (https://schema.org/Role), so it is not an unknown property there.
   */
  node(
    node: Record<string, unknown>,
    path: string,
    depth: number,
    parentKnown: readonly string[],
    heldBy: string | null = null,
  ): string | null {
    if (depth > MAX_LD_JSON_NESTING) {
      throw new Error(
        `validateBlock: nodes nested deeper than ${MAX_LD_JSON_NESTING} at ${path} — ` +
          "the analyzer never stores such a block",
      );
    }
    const id = definedId(node);
    if (id !== null) this.definedIds.add(this.resolveId(id));

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
    const isRole = typed && known.some((t) => isSubtypeOf(t, "Role"));
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
      const roleRepeat = isRole && def !== undefined && name === heldBy;
      if (primary !== null && !roleRepeat && (def === undefined || !propertyAppliesTo(name, known))) {
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
      // A typed node with no property is empty AND still a node: its type is
      // judged below like any other's.
      if (!isRecord(value) || !("@type" in value)) return;
    }
    const reference = bareReferenceId(value);
    if (reference !== null) {
      this.reference(path, reference);
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
    const nestedType = this.node(value, path, depth + 1, parentKnown, rangeOf);
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

/**
 * The base the block's ids resolve against: the document URL, then each
 * `@base` the top-level `@context` declares, in order (a relative one resolved
 * against the base before it; `"@base": null` removes the base; a `null`
 * context entry resets it to the document URL). A `@base` that cannot
 * be resolved removes it too, so ids stay as written rather than resolving
 * against a base the markup did not mean.
 */
function documentBase(context: unknown, documentUrl: string): string | null {
  let base: string | null = documentUrl;
  for (const entry of Array.isArray(context) ? context : [context]) {
    // A null context resets the active context, and with it the base, to the
    // document's (JSON-LD 1.1, Context Processing).
    if (entry === null) {
      base = documentUrl;
      continue;
    }
    if (!isRecord(entry) || !("@base" in entry)) continue;
    const declared = entry["@base"];
    if (typeof declared !== "string") {
      base = null;
      continue;
    }
    try {
      base = base === null ? new URL(declared).href : new URL(declared, base).href;
    } catch {
      base = null;
    }
  }
  return base;
}

/**
 * Validate one stored structured-data block found on the page at
 * `documentUrl`, the base its ids resolve against. Throws on a block that is
 * not a JSON object, and on a document URL that is not absolute (the
 * derivation passes `pages.url`, which always is).
 */
export function validateBlock(raw: unknown, documentUrl: string): BlockValidation {
  if (!isRecord(raw)) {
    throw new Error(
      `validateBlock: a stored block must be a JSON object, got ${Array.isArray(raw) ? "an array" : typeof raw}`,
    );
  }
  try {
    new URL(documentUrl);
  } catch {
    throw new Error(`validateBlock: the document URL '${documentUrl}' is not an absolute URL`);
  }
  const walker = new Walker(judgedContext(raw["@context"]), documentBase(raw["@context"], documentUrl));
  const ownKeys = Object.keys(raw).filter((key) => key !== "@context");
  const onlyId = ownKeys.length === 1 && ownKeys[0] === "@id" ? bareReferenceId({ "@id": raw["@id"] }) : null;
  let topType: string | null = null;
  if (onlyId !== null) walker.rootReference(onlyId);
  else topType = walker.node(raw, "$", 1, []);
  const unresolvedAll = walker.referenceIds.filter((id) => !walker.definedIds.has(id));
  return {
    topType,
    unknownTypes: walker.lists.unknownTypes,
    unknownProperties: walker.lists.unknownProperties,
    propertyStatus: walker.lists.propertyStatus,
    typeMismatches: walker.lists.typeMismatches,
    emptyValues: walker.lists.emptyValues,
    definedIds: [...walker.definedIds],
    references: walker.lists.references,
    unresolved: unresolvedAll,
    unresolvedCount: unresolvedAll.length,
    nodes: walker.lists.nodes,
    outsideVocabulary: walker.outside,
    listsCapped: walker.capped,
    cappedLists: [...walker.cappedLists],
    judged: walker.judged,
  };
}

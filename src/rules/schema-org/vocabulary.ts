import { SCHEMA_ORG_DATATYPES, SCHEMA_ORG_PROPERTIES, SCHEMA_ORG_TYPES } from "./vocabulary.generated.js";

type PropertyDef = (typeof SCHEMA_ORG_PROPERTIES)[string];

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isKnownType(name: string): boolean {
  return has(SCHEMA_ORG_TYPES, name);
}

/** A primitive schema.org DataType leaf (Text, URL, Number, Date, …): a value kind, not a node type. */
export function isDataType(name: string): boolean {
  return SCHEMA_ORG_DATATYPES.includes(name);
}

const ancestorCache = new Map<string, ReadonlySet<string>>();

/** The type and every ancestor. Throws for a type not in the vocabulary. */
export function ancestors(name: string): ReadonlySet<string> {
  const hit = ancestorCache.get(name);
  if (hit) return hit;
  if (!isKnownType(name)) throw new Error(`unknown schema.org type "${name}"`);
  const out = new Set<string>([name]);
  for (const parent of SCHEMA_ORG_TYPES[name]!) for (const a of ancestors(parent)) out.add(a);
  ancestorCache.set(name, out);
  return out;
}

export function isSubtypeOf(name: string, of: string): boolean {
  return ancestors(name).has(of);
}

/** The type and every descendant, sorted. Throws for a type not in the vocabulary. */
export function descendants(name: string): readonly string[] {
  if (!isKnownType(name)) throw new Error(`unknown schema.org type "${name}"`);
  return Object.keys(SCHEMA_ORG_TYPES)
    .filter((t) => ancestors(t).has(name))
    .sort();
}

export function propertyDef(name: string): PropertyDef | undefined {
  return has(SCHEMA_ORG_PROPERTIES, name) ? SCHEMA_ORG_PROPERTIES[name] : undefined;
}

/** True when any of the types is, or descends from, a type in the property's domain. */
export function propertyAppliesTo(property: string, types: readonly string[]): boolean {
  const def = propertyDef(property);
  if (!def) return false;
  return types.some((t) => isKnownType(t) && def.domain.some((d) => ancestors(t).has(d)));
}

/**
 * True when a node of one of `nodeTypes` is acceptable as the property's value:
 * an ancestor is in the range, the range includes Thing, or the node is a Role
 * (schema.org's Role pattern puts the real value inside the Role).
 */
export function rangeAccepts(property: string, nodeTypes: readonly string[]): boolean {
  const def = propertyDef(property);
  if (!def) return false;
  const known = nodeTypes.filter(isKnownType);
  if (known.some((t) => ancestors(t).has("Role"))) return true;
  if (nodeTypes.some((t) => def.range.includes(t) && (isKnownType(t) || SCHEMA_ORG_DATATYPES.includes(t)))) return true;
  if (def.range.includes("Thing")) return known.length > 0;
  return known.some((t) => def.range.some((r) => ancestors(t).has(r)));
}

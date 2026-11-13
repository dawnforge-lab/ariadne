/**
 * How a structured-data value is read: whether a JSON value declares
 * something, and whether a dotted path through nested nodes reaches one.
 *
 * Moved here from `src/rules/derive/field-presence.ts` (29a T5) so the Google
 * profiles (`google-features.ts`) and the query rules share one reading.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The spellings of a product's GTIN.
 *
 * `gtin` with the code's length appended is how schema.org spells the same
 * identifier at each length, and the checklist's CHECK-44 names `gtin`, `gtin13`
 * and `ean` in one breath as alternatives ("gtin / gtin13 / ean / mpn —
 * product identifiers for Google Shopping"). A product carrying a `gtin13` has
 * a GTIN, so a profile field called `gtin` that only looked at the key `gtin`
 * would report a missing identifier to a client who supplied one — the false
 * accusation the whole presence blob exists to avoid.
 *
 * `ean` is not a schema.org property (release 30.1); it stays here because the
 * field-presence derivation reads it. The Google merchant-listing profile names
 * only the vocabulary's spellings.
 *
 * `mpn` is deliberately NOT here: it is a different identifier (the
 * manufacturer's own part number, not a GTIN), the checklist names it
 * separately, and a product may honestly have one and not the other. It is its
 * own recommended field.
 */
export const GTIN_FIELDS: readonly string[] = [
  "gtin",
  "gtin8",
  "gtin12",
  "gtin13",
  "gtin14",
  "ean",
];

/**
 * Whether a JSON value declares something.
 *
 * The rule layer's `present()` applied to JSON: a key whose value is null, an
 * empty (or blank) string, or an empty array declares nothing, and reading it
 * as a declaration would hide a page from the rule that reports the absence
 * while every other reader treats the field as missing (hard rule 1).
 *
 * An array counts when at least one member does, so `image: ["", "/a.jpg"]` is
 * an image. An object counts as present whatever it holds: this engine has no
 * profile for an arbitrary nested type, and calling `brand: {}` absent would be
 * a judgement about a shape nothing here checked.
 */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((entry) => hasValue(entry));
  return true;
}

/**
 * Whether any of a Product's offers carries a usable value under `field`.
 *
 * `offers` may be a single Offer or an array of them (one per variant), and one
 * offer is enough — a rich result needs one complete offer rather than every
 * variant being complete. A product whose in-stock size carries an availability
 * and whose sold-out sizes do not has an availability. A `price` of `0` counts:
 * a free item has a price, and `hasValue` only rejects emptiness, never a falsy
 * number.
 */
export function offersCarry(value: unknown, field: string): boolean {
  return carries(value, [field]);
}

/**
 * The members of a property value: an array's entries, a JSON-LD `@list` /
 * `@set` container's contents (unwrapped exactly as the validator's walk does),
 * or the value itself. An absent value has none.
 */
export function membersOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => membersOf(entry));
  if (isRecord(value)) {
    if ("@list" in value) return membersOf(value["@list"]);
    if ("@set" in value) return membersOf(value["@set"]);
  }
  return [value];
}

/**
 * A bare node reference: `{"@id": …}` with a non-empty `@id`, and nothing else
 * that describes the node (no `@type`, no non-`@` key). An empty `@id` points
 * nowhere, so it is no reference. It points at a node described elsewhere — in
 * another block of the `@graph`, or on another page — so nothing can be said
 * here about what that node carries.
 */
export function isBareReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasValue(value["@id"]) &&
    !("@type" in value) &&
    Object.keys(value).every((key) => key.startsWith("@"))
  );
}

/**
 * Whether `value` reaches a usable value along `path`: each step reads the key
 * from every object member of the current value (`membersOf`), and one member
 * that gets all the way is enough — the `offersCarry` reading applied at every
 * level. `carries(node, ["offers", "price"])` is "some member of `offers`
 * carries `price`". An empty path asks `hasValue(value)`.
 *
 * Two members end the walk as satisfied, because nothing here can show they
 * lack the rest of the path and reporting it missing would be a false
 * accusation (29a T5 review; gate clause 2 — when unsure, under-report):
 *  - a bare reference (`isBareReference`) satisfies any deeper step;
 *  - a non-empty string satisfies a final `name` step: `author: "Jane"` names
 *    the author, which is what `author.name` asks.
 */
export function carries(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return hasValue(value);
  const [head, ...rest] = path;
  return membersOf(value).some((member) => {
    if (isBareReference(member)) return true;
    if (typeof member === "string") return rest.length === 0 && head === "name" && hasValue(member);
    return isRecord(member) && carries(member[head!], rest);
  });
}

/**
 * Whether `path` reaches a member that is more than a bare reference — what a
 * conditional requirement ("when `offers` is present") fires on. A value made
 * only of references says nothing about what the referenced nodes carry.
 */
export function describes(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) {
    return membersOf(value).some((member) => hasValue(member) && !isBareReference(member));
  }
  const [head, ...rest] = path;
  return membersOf(value).some(
    (member) => isRecord(member) && !isBareReference(member) && describes(member[head!], rest),
  );
}

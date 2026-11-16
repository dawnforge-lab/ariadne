/**
 * How a structured-data value is read: whether a JSON value declares
 * something, whether it is empty, and whether it is a bare node reference.
 *
 * `hasValue` was moved here from `src/rules/derive/field-presence.ts` (29a T5)
 * and is read by `schema.self-serving-reviews`. The rest are the 29a rework's
 * facts (`validate.ts`): empty values and references, both as the JSON-LD
 * syntax defines them.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a JSON value declares something.
 *
 * The rule layer's `present()` applied to JSON: a key whose value is null, an
 * empty (or blank) string, or an empty array declares nothing, and reading it
 * as a declaration would hide a page from the rule that reports the absence
 * while every other reader treats the field as missing (hard rule 1).
 *
 * An array counts when at least one member does, so `image: ["", "/a.jpg"]` is
 * an image. An object counts as present whatever it holds.
 */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((entry) => hasValue(entry));
  return true;
}

/**
 * The keywords that carry content: a node holding one of them says something
 * even with no property. `@type`, `@context`, `@language` and the like do not —
 * they describe a node, they are not its properties.
 */
const CONTENT_KEYWORDS: ReadonlySet<string> = new Set([
  "@id",
  "@value",
  "@list",
  "@set",
  "@graph",
  "@reverse",
  "@included",
  "@nest",
]);

/**
 * Whether one property value is EMPTY markup, as `schema.empty-value` reports
 * it (spec §29a amendment):
 *  - `""` or whitespace-only text;
 *  - `[]`;
 *  - an object with no properties and no `@id` — `{}`, and also a node holding
 *    only keywords such as `{"@type": "Offer"}`: keywords are not properties,
 *    so a typed node with nothing in it states only that a thing exists. A
 *    blank `@id` (`""` or whitespace) is no `@id`;
 *  - a JSON-LD value object whose `@value` is blank text (`{"@value": " "}`,
 *    with or without `@language` / `@type`), which is `""` written longhand.
 *
 * `0`, `false`, `null`, `{"@id": "x"}` and any object with a property are not
 * empty: a zero is a value, JSON-LD defines `null` as "ignore this property",
 * and a reference says which node. A `@list` / `@set` container is not empty
 * here for holding no members; the walk reads its contents and reports an
 * empty one at the container's path, as it does each empty array member at its
 * own index.
 */
export function isEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (!isRecord(value)) return false;
  if ("@value" in value) {
    const literal = value["@value"];
    return typeof literal === "string" && literal.trim() === "";
  }
  return !Object.keys(value).some((key) => {
    // A blank `@id` names no node: no `@id`, as `definedId` and `bareReferenceId` read it.
    if (key === "@id") return typeof value["@id"] !== "string" || value["@id"].trim() !== "";
    return !key.startsWith("@") || CONTENT_KEYWORDS.has(key);
  });
}

/**
 * Whether a property value carries anything that is not empty — what
 * `schema.property-coverage` counts. An array or a `@list` / `@set` container
 * carries when one member does, a value object when its `@value` does; `null`
 * carries nothing. `["", " "]` carries nothing although no single test of
 * `isEmptyValue` says so of the array itself.
 */
export function carriesValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (isEmptyValue(value)) return false;
  if (Array.isArray(value)) return value.some((entry) => carriesValue(entry));
  if (isRecord(value)) {
    if ("@value" in value) return carriesValue(value["@value"]);
    if ("@list" in value) return carriesValue(value["@list"]);
    if ("@set" in value) return carriesValue(value["@set"]);
  }
  return true;
}

/**
 * The id of a BARE node reference — an object whose only key is `@id`, holding
 * non-blank text — or null for anything else. JSON-LD reads such an object as
 * the node of that id, described elsewhere: in another node of the document or
 * on another site. A blank `@id` names no node here, so it is not a reference.
 */
export function bareReferenceId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "@id") return null;
  const id = value["@id"];
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/**
 * The id a node DEFINES: its `@id`, when it is non-blank text and the node
 * carries a `@type` or a property. Null otherwise. Other keywords are not
 * content: an `@graph` member `{"@id": "#x"}` is stored with its container's
 * `@context` copied on, and is still only a reference (review M1).
 */
export function definedId(node: Record<string, unknown>): string | null {
  const id = node["@id"];
  if (typeof id !== "string" || id.trim() === "") return null;
  return Object.keys(node).some((key) => key === "@type" || !key.startsWith("@")) ? id : null;
}

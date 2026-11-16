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
 * Whether one property value is EMPTY markup, as `schema.empty-value` reports
 * it:
 *  - `""` or whitespace-only text;
 *  - `[]`;
 *  - `{}`, an object with no key at all (so no `@id` and no `@type`);
 *  - a JSON-LD value object whose `@value` is blank text (`{"@value": " "}`,
 *    with or without `@language` / `@type`), which is `""` written longhand.
 *
 * `0`, `false`, `null`, `{"@id": "x"}` and any object with a key are not
 * empty: a zero is a value, JSON-LD defines `null` as "ignore this property",
 * and a reference or a typed node says something. An array or container is not
 * empty for holding empty members; the walk visits each member and reports it
 * at its own index.
 */
export function isEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (!isRecord(value)) return false;
  if ("@value" in value) {
    const literal = value["@value"];
    return typeof literal === "string" && literal.trim() === "";
  }
  return Object.keys(value).length === 0;
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
 * carries anything besides it (a `@type` or a property). Null otherwise.
 */
export function definedId(node: Record<string, unknown>): string | null {
  const id = node["@id"];
  if (typeof id !== "string" || id.trim() === "") return null;
  return Object.keys(node).some((key) => key !== "@id") ? id : null;
}

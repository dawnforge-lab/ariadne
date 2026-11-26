/**
 * The SQL side of the `validation_jsonb` contract (`blockValidationSchema`,
 * validate.ts): what makes a stored verdict one this ruleset wrote, and how a
 * node's stated types are read in SQL. Shared by every reader that does not
 * parse a blob with zod — the per-page rules' selection, the template rule,
 * the property-coverage metric, and the API listing, CSV view and their
 * up-front 409 — so "re-run the rules" means the same thing on every surface.
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * A node entry the validator did not write: not an object, or missing a key,
 * or a key of the wrong kind. The `exists` clauses are not redundant: in lax
 * mode a MISSING key yields an empty sequence, whose `.type()` comparison is
 * false, so without them an entry lacking the key would pass.
 */
const MALFORMED_NODE =
  'lax $.nodes[*] ? (@.type() != "object" || !exists(@.path) || !exists(@."type")' +
  ' || !exists(@.types) || @.types.type() != "array"' +
  ' || !exists(@.typesCapped) || @.typesCapped.type() != "boolean"' +
  ' || !exists(@.properties) || @.properties.type() != "array"' +
  ' || !exists(@.emptyProperties) || @.emptyProperties.type() != "array"' +
  ' || !exists(@.propertiesCapped) || @.propertiesCapped.type() != "boolean")';

/**
 * True for a non-null verdict NOT in the shape this ruleset writes: one from
 * before the 29a rework (no `nodes`), from before a later field existed
 * (`definedIds`, `cappedLists`, `judged`, `unresolved` / `unresolvedCount` /
 * `idsTruncated`, a node's `types` / `typesCapped`), one whose `unresolvedCount`
 * does not match the length of `unresolved` (equal, or at least that when
 * `idsTruncated`; a verdict written when `unresolved` was cut at 50),
 * or a node entry of the wrong shape. Such a blob is refused with "re-run the
 * rules" wherever it is met, never read. True on a null blob too; a caller
 * that words "no verdict at all" differently tests `is null` first.
 */
export function staleBlob(blob: SQL): SQL {
  return sql`(jsonb_typeof(${blob} -> 'nodes') is distinct from 'array'
    or jsonb_typeof(${blob} -> 'definedIds') is distinct from 'array'
    or jsonb_typeof(${blob} -> 'cappedLists') is distinct from 'array'
    or jsonb_typeof(${blob} -> 'judged') is distinct from 'boolean'
    or jsonb_typeof(${blob} -> 'unresolved') is distinct from 'array'
    or jsonb_typeof(${blob} -> 'unresolvedCount') is distinct from 'number'
    or jsonb_typeof(${blob} -> 'idsTruncated') is distinct from 'boolean'
    or (case when jsonb_typeof(${blob} -> 'unresolved') = 'array'
              and jsonb_typeof(${blob} -> 'unresolvedCount') = 'number'
              and jsonb_typeof(${blob} -> 'idsTruncated') = 'boolean'
         then case when (${blob} ->> 'idsTruncated')::boolean
                   then (${blob} ->> 'unresolvedCount')::numeric < jsonb_array_length(${blob} -> 'unresolved')
                   else (${blob} ->> 'unresolvedCount')::numeric <> jsonb_array_length(${blob} -> 'unresolved') end
         else false end)
    or jsonb_path_exists(${blob}, ${sql.raw(`'${MALFORMED_NODE}'`)}))`;
}

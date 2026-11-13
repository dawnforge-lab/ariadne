/**
 * Derives the pinned schema.org vocabulary and writes
 * src/rules/schema-org/vocabulary.generated.ts.
 *
 *   npx tsx scripts/derive-schema-org.ts <schemaorg-all-https.jsonld> <release> <release-date>
 *
 * Source: `schemaorg-all-https.jsonld` from the newest numbered directory under
 * https://github.com/schemaorg/schemaorg/tree/main/data/releases/. The release
 * date comes from the repository's docs/releases.html.
 *
 * Rules:
 *  - Types are `rdfs:Class` entries other than DataTypes. DataTypes are classes
 *    typed `schema:DataType`, `schema:DataType` itself, and subclasses of it.
 *  - Terms whose `schema:isPartOf` is the attic are dropped. Pending terms are
 *    kept; a property is `pending` from `schema:isPartOf` pending.schema.org.
 *    `supersededBy` is recorded from `schema:supersededBy`; if both apply,
 *    pending wins for `status` and `supersededBy` is kept anyway.
 *  - Enumeration members (individuals typed by an enumeration class) are dropped.
 *  - Domain/range names that point at a dropped term are dropped with it.
 *  - External-vocabulary stubs in the graph (bibo:Issue, ...) are not terms.
 *  - Every name is bare (no `schema:` prefix). Output keys are sorted, so a
 *    re-run is byte-identical. Nothing is fetched here.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Ref = { "@id": string };
type Node = Record<string, unknown> & { "@id": string };

const OUT = fileURLToPath(new URL("../src/rules/schema-org/vocabulary.generated.ts", import.meta.url));
const ATTIC = "https://attic.schema.org";
const PENDING = "https://pending.schema.org";

const [, , file, release, releaseDate] = process.argv;
if (!file || !release || !releaseDate) {
  throw new Error("usage: derive-schema-org.ts <schemaorg-all-https.jsonld> <release> <release-date>");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw new Error(`release date must be YYYY-MM-DD, got ${releaseDate}`);

const raw = readFileSync(file);
const sha256 = createHash("sha256").update(raw).digest("hex");
const graph = (JSON.parse(raw.toString("utf8")) as { "@graph": Node[] })["@graph"];
if (!Array.isArray(graph)) throw new Error("no @graph in the release file");

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const ids = (v: unknown): string[] => arr(v as Ref | Ref[] | undefined).map((r) => r["@id"]);
const bare = (id: string): string => {
  if (!id.startsWith("schema:")) throw new Error(`non-schema id ${id}`);
  return id.slice("schema:".length);
};
const typesOf = (n: Node): string[] => arr(n["@type"] as string | string[] | undefined);
const partOf = (n: Node): string[] => ids(n["schema:isPartOf"]);
const inAttic = (n: Node) => partOf(n).includes(ATTIC);
// The graph also holds external-vocabulary stubs (bibo:Issue, ...); only schema: terms are ours.
const ours = (n: Node) => n["@id"].startsWith("schema:");

const classes = graph.filter((n) => typesOf(n).includes("rdfs:Class") && ours(n) && !inAttic(n));
const props = graph.filter((n) => typesOf(n).includes("rdf:Property") && ours(n) && !inAttic(n));

// DataTypes: DataType itself, classes typed DataType, and subclasses of those.
const parentsOf = new Map<string, string[]>(
  classes.map((c) => [c["@id"], ids(c["rdfs:subClassOf"]).filter((p) => p.startsWith("schema:"))]),
);
const dataTypeIds = new Set<string>(["schema:DataType"]);
for (const c of classes) if (typesOf(c).includes("schema:DataType")) dataTypeIds.add(c["@id"]);
for (let grew = true; grew; ) {
  grew = false;
  for (const [id, parents] of parentsOf) {
    if (!dataTypeIds.has(id) && parents.some((p) => dataTypeIds.has(p))) {
      dataTypeIds.add(id);
      grew = true;
    }
  }
}

const typeIds = new Set(classes.map((c) => c["@id"]).filter((id) => !dataTypeIds.has(id)));
const known = new Set([...typeIds, ...dataTypeIds]);

const types: Record<string, string[]> = {};
for (const id of [...typeIds].sort()) {
  types[bare(id)] = (parentsOf.get(id) ?? []).filter((p) => typeIds.has(p)).map(bare).sort();
}
const datatypes = [...dataTypeIds].map(bare).sort();

const propIds = new Set(props.map((p) => p["@id"]));
type Prop = { domain: string[]; range: string[]; status?: "pending" | "superseded"; supersededBy?: string };
const properties: Record<string, Prop> = {};
for (const p of props.sort((a, b) => (a["@id"] < b["@id"] ? -1 : 1))) {
  const id = p["@id"];
  const domain = ids(p["schema:domainIncludes"]).filter((d) => known.has(d)).map(bare).sort();
  const range = ids(p["schema:rangeIncludes"]).filter((d) => known.has(d)).map(bare).sort();
  const sup = ids(p["schema:supersededBy"]);
  if (sup.length > 1) throw new Error(`${id} is superseded by more than one term`);
  const entry: Prop = { domain, range };
  if (partOf(p).includes(PENDING)) entry.status = "pending";
  else if (sup.length) entry.status = "superseded";
  if (sup.length) {
    if (!propIds.has(sup[0]!) && !known.has(sup[0]!)) throw new Error(`${id} is superseded by dropped term ${sup[0]}`);
    entry.supersededBy = bare(sup[0]!);
  }
  properties[bare(id)] = entry;
}

const header = `/**
 * GENERATED by scripts/derive-schema-org.ts. Do not edit by hand.
 *
 * The schema.org vocabulary: types with their direct parents, DataTypes, and
 * properties with domain, range and pending/superseded status.
 *
 * Release:        ${release}
 * Source:         schemaorg-all-https.jsonld
 * Source sha256:  ${sha256}
 * Release date:   ${releaseDate}
 * Changes:        attic terms dropped; enumeration members dropped; comments/labels dropped
 *
 * Re-deriving this file is a deliberate commit that bumps RULESET_VERSION. It
 * is never synced automatically (spec 29a).
 *
 * Source: schema.org, https://schema.org, licensed CC BY-SA 3.0
 * (https://creativecommons.org/licenses/by-sa/3.0/). Attribution: schema.org.
 */
`;
const body = `
export const SCHEMA_ORG_RELEASE: string = ${JSON.stringify(release)};

export const SCHEMA_ORG_TYPES: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(types)};

export const SCHEMA_ORG_DATATYPES: readonly string[] = ${JSON.stringify(datatypes)};

export const SCHEMA_ORG_PROPERTIES: Readonly<
  Record<string, { domain: readonly string[]; range: readonly string[]; status?: "pending" | "superseded"; supersededBy?: string }>
> = ${JSON.stringify(properties)};
`;
writeFileSync(OUT, header + body);
console.log(
  `${release}: ${Object.keys(types).length} types, ${datatypes.length} datatypes, ${Object.keys(properties).length} properties`,
);

/**
 * The structured-data metric (29a rework): what the site's markup says, type by
 * type, as counts — never as a verdict.
 *
 * `schema.property-coverage` claims CHECK-44 ("Product schema completeness")
 * with facts: for each schema type, how many top-level nodes carry it, and for
 * each property those nodes use, how many carry a non-empty value. Which
 * properties a type NEEDS depends on what the site means its markup to say,
 * which is the agent's judgement; the engine names no required set (the owner's
 * rule for structured data: web standards, not one search engine).
 *
 * The shape mirrors `content.metrics-by-type`: a site row (so an empty crawl
 * still answers, and an absent row means the rule did not run) beside one row
 * per cohort — here a `schema_type`, named as the markup states it.
 *
 * **The cohort.** Top-level nodes (`BlockValidation.nodes`: one per stored
 * block, so each `@graph` member is one) on JUDGED pages, the cohort every
 * `schema.*` rule reads. An untyped node counts in the site row only. A type
 * outside the vocabulary counts under the name the markup gave it.
 *
 * **Memory (hard rule 6).** Every count is taken in Postgres over the stored
 * blobs; nothing here holds a node. The answer is bounded too: at most
 * `COVERAGE_MAX_TYPES` type rows and `COVERAGE_MAX_PROPERTIES` properties per
 * type, ranked by count, and what was left out is COUNTED on the row
 * (`typesNotListed`, `propertiesNotListed`), never dropped without a word. A
 * node's own property list is capped by the validator; `propertyListsCapped`
 * says how many nodes were cut short.
 *
 * **Not measured.** A crawl not wholly at extraction 4 read no microdata or RDFa
 * nodes, so its counts would describe the extractor: the rule writes no rows and
 * `extraction.not-recorded` speaks (ruling R0.7). A judged block with no verdict,
 * or one in a shape this ruleset does not write, throws: re-run the rules.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { JUDGED, metricRow, metricRule, type MetricIdentity } from "../helpers.js";
import { assertCrawl } from "../query/crawl-evidence.js";
import { v4Gate } from "../query/page-facts.js";
import { expandMap } from "../registry/metric-table.js";
import type { Metric, MetricRule } from "../registry/registry.js";
import { num, text } from "./cohort.js";

const STRUCTURED_DATA = "structured-data";

/** The most type rows one crawl's answer lists, by node count. */
export const COVERAGE_MAX_TYPES = 100;

/** The most properties one type's row lists, by the count of nodes carrying a value. */
export const COVERAGE_MAX_PROPERTIES = 100;

/**
 * A node entry the validator did not write: not an object, or missing its
 * type key or either property list.
 */
const MALFORMED_NODE =
  'lax $.nodes[*] ? (@.type() != "object" || !exists(@."type") || !exists(@.propertiesCapped)' +
  ' || !exists(@.properties) || !exists(@.emptyProperties)' +
  ' || @.properties.type() != "array" || @.emptyProperties.type() != "array")';

type CoverageRow = {
  scope: string;
  scope_value: string;
  nodes: number;
  capped: number;
  not_listed: number;
  properties: Record<string, unknown> | null;
};

async function propertyCoverage(db: Db, crawlId: string, self: MetricIdentity): Promise<Metric[]> {
  await assertCrawl(db, crawlId, self.id);
  if (!(await v4Gate(db, crawlId)).recorded) return [];

  const health = await db.execute<{ underived: number; unreadable: number }>(sql`
    select count(*) filter (where sd.validation_jsonb is null)::int as underived,
           count(*) filter (
             where sd.validation_jsonb is not null
               and (jsonb_typeof(sd.validation_jsonb -> 'nodes') is distinct from 'array'
                    or jsonb_path_exists(sd.validation_jsonb, ${sql.raw(`'${MALFORMED_NODE}'`)}))
           )::int as unreadable
    from pages p
    join structured_data sd on sd.crawl_id = ${crawlId} and sd.page_id = p.id
    where p.crawl_id = ${crawlId} and ${JUDGED("p")}`);
  const { underived, unreadable } = health.rows[0]!;
  if (underived > 0) {
    throw new Error(
      `${self.id}: crawl '${crawlId}' has ${underived} structured-data block(s) on judged pages ` +
        "with no validation — re-run the rules",
    );
  }
  if (unreadable > 0) {
    throw new Error(
      `${self.id}: crawl '${crawlId}' has ${unreadable} structured-data block(s) on judged pages ` +
        "whose validation is not in the shape this ruleset writes — re-run the rules",
    );
  }

  const result = await db.execute<CoverageRow>(sql`
    with nodes as (
      select n.node
      from pages p
      join structured_data sd on sd.crawl_id = ${crawlId} and sd.page_id = p.id
      cross join lateral jsonb_array_elements(sd.validation_jsonb -> 'nodes') as n(node)
      where p.crawl_id = ${crawlId} and ${JUDGED("p")}
    ),
    typed as (
      select node ->> 'type' as type, node from nodes where node ->> 'type' is not null
    ),
    types as (
      select type, count(*)::int as nodes,
             count(*) filter (where (node ->> 'propertiesCapped')::boolean)::int as capped,
             row_number() over (order by count(*) desc, type) as rank
      from typed
      group by type
    ),
    props as (
      select t.type, prop.name,
             count(*) filter (where not (t.node -> 'emptyProperties') @> to_jsonb(prop.name))::int as carried
      from typed t
      cross join lateral jsonb_array_elements_text(t.node -> 'properties') as prop(name)
      group by t.type, prop.name
    ),
    ranked as (
      select type, name, carried,
             row_number() over (partition by type order by carried desc, name) as rank
      from props
    )
    select 'site' as scope, '' as scope_value,
           (select count(*) from nodes)::int as nodes,
           (select count(*) filter (where (node ->> 'propertiesCapped')::boolean) from nodes)::int as capped,
           (select count(*) from types where rank > ${COVERAGE_MAX_TYPES})::int as not_listed,
           null::jsonb as properties
    union all
    select 'schema_type', ty.type, ty.nodes, ty.capped,
           (select count(*) from ranked r where r.type = ty.type and r.rank > ${COVERAGE_MAX_PROPERTIES})::int,
           coalesce(
             (select jsonb_object_agg(r.name, r.carried) from ranked r
               where r.type = ty.type and r.rank <= ${COVERAGE_MAX_PROPERTIES}),
             '{}'::jsonb)
    from types ty
    where ty.rank <= ${COVERAGE_MAX_TYPES}`);

  return result.rows.map((row) => {
    const nodes = num(row.nodes, "nodes", self.id);
    const propertyListsCapped = num(row.capped, "capped", self.id);
    const notListed = num(row.not_listed, "not_listed", self.id);
    if (row.scope === "site") {
      return metricRow(self, {
        scope: "site",
        value: { nodes, propertyListsCapped, typesNotListed: notListed },
      });
    }
    const properties = row.properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      throw new Error(`${self.id}: the properties of type '${row.scope_value}' came back as ${typeof properties}`);
    }
    return metricRow(self, {
      scope: "schema_type",
      scopeValue: text(row.scope_value, "scope_value", self.id),
      value: {
        nodes,
        propertyListsCapped,
        propertiesNotListed: notListed,
        properties: Object.fromEntries(
          Object.entries(properties).map(([name, n]) => [name, num(n, `properties.${name}`, self.id)]),
        ),
      },
    });
  });
}

export const schemaMetrics: MetricRule[] = [
  metricRule(
    "schema.property-coverage",
    ["CHECK-44"],
    STRUCTURED_DATA,
    expandMap("properties", "Schema Type", "Property", "Nodes With Value", undefined, [
      { key: "nodes", label: "Nodes" },
      { key: "propertyListsCapped", label: "Nodes With Property List Capped" },
      { key: "typesNotListed", label: "Types Not Listed" },
      { key: "propertiesNotListed", label: "Properties Not Listed" },
    ]),
    async (db, crawlId, self) => propertyCoverage(db, crawlId, self),
  ),
];

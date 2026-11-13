/**
 * The per-node schema rules: what the node validator said about each stored
 * structured-data block (CHECK-43, and CHECK-44 for the two Google rules).
 *
 * These rules read, they do not judge. `deriveSchemaValidation`
 * (src/rules/derive/schema-validation.ts) ran every block through the validator
 * and wrote its verdict to `structured_data.validation_jsonb`; each rule here
 * turns one list of that verdict into findings.
 *
 *  - `schema.parse-error`                      JSON-LD / microdata the parser could not read
 *  - `schema.unknown-type`                     a `@type` schema.org does not define
 *  - `schema.unknown-property`                 a property the node's type does not take
 *  - `schema.property-pending-or-superseded`   a property schema.org has not settled or has replaced
 *  - `schema.embedded-type-mismatch`           a nested node of a type the property refuses
 *  - `schema.google-required-missing`          a Google rich-result feature missing a required field
 *  - `schema.google-recommended-missing`       the same, for a recommended field
 *  - `schema.deprecated-feature`               markup for a feature Google has withdrawn
 *  - `schema.template-inconsistent`            a page lacking the type most pages of its kind carry
 *
 * **One finding per page (ruling R0.3).** A page's problems ride in one
 * finding's evidence, up to `MAX_PROBLEMS_IN_EVIDENCE` of them plus the full
 * count; the per-node detail is the `structured_data_nodes` CSV view. The Google
 * rules judge each node on its own, so a page with one complete and one
 * incomplete Product fires.
 *
 * **Memory (hard rules 3 and 6).** The SQL groups the blocks of each page and
 * returns the first `caps.listing` pages, so RAM is O(listing cap x blocks per
 * page), never O(blocks in the crawl).
 *
 * **A block with no verdict is an error, not a clean block.** A null
 * `validation_jsonb` on a judged page means the derivation did not run. Reading
 * it as "no problems" would be a rule that passes because its data is missing
 * (hard rule 1), so the query selects such pages too and the rule throws.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { JUDGED, queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { DEPRECATED_FEATURES } from "../schema-org/google-features.js";
import { blockValidationSchema, type BlockValidation } from "../schema-org/validate.js";
import { assertCrawl, capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";
import { v4Gate } from "./page-facts.js";
import { judgementOr } from "../registry/types.js";

const CATEGORY = "structured-data" as const;

/** Problems carried in one finding's evidence; the full count is `problemCount`. */
export const MAX_PROBLEMS_IN_EVIDENCE = 20;

const PARSE_ERROR: RuleIdentity = { id: "schema.parse-error", severity: "warning" };
const UNKNOWN_TYPE: RuleIdentity = { id: "schema.unknown-type", severity: "warning" };
const UNKNOWN_PROPERTY: RuleIdentity = { id: "schema.unknown-property", severity: "warning" };
const PENDING: RuleIdentity = { id: "schema.property-pending-or-superseded", severity: "info" };
const MISMATCH: RuleIdentity = { id: "schema.embedded-type-mismatch", severity: "warning" };
const GOOGLE_REQUIRED: RuleIdentity = { id: "schema.google-required-missing", severity: "warning" };
const GOOGLE_RECOMMENDED: RuleIdentity = { id: "schema.google-recommended-missing", severity: "info" };
const DEPRECATED: RuleIdentity = { id: "schema.deprecated-feature", severity: "info" };
const TEMPLATE: RuleIdentity = { id: "schema.template-inconsistent", severity: "warning" };

type Problem = Record<string, unknown>;

interface BlockRow {
  id: number;
  format: string;
  validation: unknown;
}

/**
 * `parse-error`: counts straight off `pages`. The microdata column is null on a
 * page extracted below version 4, so such a page is read as JSON-LD only and the
 * evidence says so with a null rather than a zero.
 */
async function parseErrorFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await assertCrawl(db, crawlId, PARSE_ERROR.id);
  const result = await db.execute<{
    id: string;
    url: string;
    json_ld: number;
    microdata: number | null;
    total_matches: number;
  }>(sql`
    select p.id, p.url,
           p.structured_data_parse_errors as json_ld,
           p.structured_data_microdata_errors as microdata,
           count(*) over ()::int as total_matches
    from pages p
    where p.crawl_id = ${crawlId}
      and ${JUDGED("p")}
      and (p.structured_data_parse_errors > 0 or p.structured_data_microdata_errors > 0)
    order by p.url
    ${limitTo(caps.listing)}`);
  const findings = result.rows.map((row) =>
    queryFinding(PARSE_ERROR, {
      pageId: row.id,
      pageUrl: row.url,
      evidence: { jsonLdParseErrors: row.json_ld, microdataErrors: row.microdata },
      dedupeKey: row.url,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

interface PerPageSpec {
  identity: RuleIdentity;
  /** SQL over `sd` that is true when the block's verdict has something for this rule. */
  hasProblems: SQL;
  /** The problems one block contributes, in list order. */
  problems: (block: BlockValidation, format: string) => Problem[];
  /** Extra evidence computed from all of a page's problems. */
  extra?: (problems: Problem[]) => Record<string, unknown>;
  /** Whether `problems` itself is listed in the evidence. */
  listProblems: boolean;
}

const listHas = (key: string): SQL =>
  sql`coalesce(jsonb_array_length(sd.validation_jsonb -> ${sql.raw(`'${key}'`)}), 0) > 0`;

const googleHas = (missing: "missingRequired" | "missingRecommended"): SQL =>
  sql`exists (
    select 1 from jsonb_array_elements(sd.validation_jsonb -> 'googleFeatures') g
    where jsonb_array_length(g -> ${sql.raw(`'${missing}'`)}) > 0
  )`;

async function perPageFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
  spec: PerPageSpec,
): Promise<Finding[]> {
  const ruleId = spec.identity.id;
  await assertCrawl(db, crawlId, ruleId);

  // A page is selected when any block has something to say OR has no verdict
  // at all (the latter throws below). All of a selected page's blocks come back,
  // in id order, so the problems order is block id then list order.
  const result = await db.execute<{
    page_id: string;
    url: string;
    blocks: BlockRow[];
    total_matches: number;
  }>(sql`
    select p.id as page_id, p.url,
           jsonb_agg(
             jsonb_build_object('id', sd.id, 'format', sd.format, 'validation', sd.validation_jsonb)
             order by sd.id
           ) as blocks,
           count(*) over ()::int as total_matches
    from pages p
    join structured_data sd on sd.crawl_id = ${crawlId} and sd.page_id = p.id
    where p.crawl_id = ${crawlId}
      and ${JUDGED("p")}
    group by p.id, p.url
    having bool_or(sd.validation_jsonb is null or ${spec.hasProblems})
    order by p.url
    ${limitTo(caps.listing)}`);

  const findings: Finding[] = [];
  for (const row of result.rows) {
    const all: Problem[] = [];
    for (const block of row.blocks) {
      if (block.validation === null || block.validation === undefined) {
        throw new Error(
          `${ruleId}: ${row.url} structured data has no validation — re-run the rules`,
        );
      }
      const parsed = blockValidationSchema.safeParse(block.validation);
      if (!parsed.success) {
        throw new Error(
          `${ruleId}: structured_data row ${block.id} of ${row.url} has a malformed validation blob: ${parsed.error.message}`,
        );
      }
      all.push(...spec.problems(parsed.data, block.format));
    }
    // The SQL selected the page on the strength of some block, so an empty
    // list here means the SQL pre-filter and the reader disagree.
    if (all.length === 0) {
      throw new Error(
        `${ruleId}: ${row.url} was selected but no block lists a problem — the SQL pre-filter and the reader disagree`,
      );
    }
    findings.push(
      queryFinding(spec.identity, {
        pageId: row.page_id,
        pageUrl: row.url,
        evidence: {
          ...(spec.extra?.(all) ?? {}),
          ...(spec.listProblems ? { problems: all.slice(0, MAX_PROBLEMS_IN_EVIDENCE) } : {}),
          problemCount: all.length,
        },
        dedupeKey: row.url,
      }),
    );
  }
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

/**
 * `template-inconsistent` (CHECK-43): within a page type, a schema type most
 * pages carry and some do not. The pages lacking it are the finding.
 *
 * Refuses a crawl that is not wholly extraction 4 (ruling R0.7): a page read
 * before microdata and RDFa were extracted has no blocks of those formats, so
 * "lacks Product" would be a statement about the extractor. The marker
 * `extraction.not-recorded` speaks for such a crawl.
 *
 * Judged pages with a null or empty `page_type` are never bucketed: an untyped
 * page is not a member of any template. Types are the bare schema.org name
 * (`schema_type`, 'unknown' excluded) of top-level blocks, counted once per page.
 *
 * One SQL statement, grouped by page type and schema type, so memory is bounded
 * by the number of (page type, schema type) groups that qualify and by the
 * listing cap, never by pages (hard rules 3 and 6).
 */
async function templateFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
  share: number,
  minPages: number,
): Promise<Finding[]> {
  await assertCrawl(db, crawlId, TEMPLATE.id);
  const gate = await v4Gate(db, crawlId);
  if (!gate.recorded) return [];
  const result = await db.execute<{
    page_id: string;
    url: string;
    page_type: string;
    schema_type: string;
    pages_with: number;
    pages_in_type: number;
    total_matches: number;
  }>(sql`
    with typed as (
      select p.id, p.url, p.page_type
      from pages p
      where p.crawl_id = ${crawlId}
        and ${JUDGED("p")}
        and p.page_type is not null and p.page_type <> ''
    ),
    sizes as (
      select page_type, count(*)::int as n from typed
      group by page_type
      having count(*) >= ${minPages}
    ),
    carried as (
      select t.page_type, sd.schema_type, count(distinct t.id)::int as c
      from typed t
      join structured_data sd on sd.crawl_id = ${crawlId} and sd.page_id = t.id
      where sd.schema_type <> 'unknown'
      group by t.page_type, sd.schema_type
    ),
    templates as (
      select c.page_type, c.schema_type, c.c, s.n
      from carried c
      join sizes s using (page_type)
      where c.c * 100 >= ${share} * s.n and c.c < s.n
    )
    select t.id as page_id, t.url, tp.page_type, tp.schema_type,
           tp.c as pages_with, tp.n as pages_in_type,
           count(*) over ()::int as total_matches
    from templates tp
    join typed t on t.page_type = tp.page_type
    where not exists (
      select 1 from structured_data sd
      where sd.crawl_id = ${crawlId} and sd.page_id = t.id
        and sd.schema_type = tp.schema_type
    )
    order by t.url, tp.schema_type
    ${limitTo(caps.listing)}`);
  const findings = result.rows.map((row) =>
    queryFinding(TEMPLATE, {
      pageId: row.page_id,
      pageUrl: row.url,
      evidence: {
        pageType: row.page_type,
        schemaType: row.schema_type,
        pagesWith: row.pages_with,
        pagesInType: row.pages_in_type,
      },
      dedupeKey: `${row.url}#${row.schema_type}`,
    }),
  );
  return noteTruncation(findings, result.rows[0]?.total_matches ?? 0);
}

const distinct = (problems: Problem[]): string[] => [
  ...new Set(problems.map((p) => p["feature"] as string)),
];

const googleSpec = (
  identity: RuleIdentity,
  missing: "missingRequired" | "missingRecommended",
): PerPageSpec => ({
  identity,
  hasProblems: googleHas(missing),
  problems: (b, format) =>
    b.googleFeatures
      .filter((g) => g[missing].length > 0)
      .map((g) => ({
        format,
        feature: g.feature,
        path: g.path,
        type: g.type,
        missing: g[missing],
      })),
  extra: (problems) => ({ features: distinct(problems) }),
  listProblems: true,
});

const SPECS = {
  unknownType: {
    identity: UNKNOWN_TYPE,
    hasProblems: listHas("unknownTypes"),
    problems: (b, format) => b.unknownTypes.map((t) => ({ format, path: t.path, type: t.type })),
    listProblems: true,
  },
  unknownProperty: {
    identity: UNKNOWN_PROPERTY,
    hasProblems: listHas("unknownProperties"),
    problems: (b, format) =>
      b.unknownProperties.map((u) => ({
        format,
        path: u.path,
        type: u.type,
        property: u.property,
      })),
    listProblems: true,
  },
  pending: {
    identity: PENDING,
    hasProblems: listHas("propertyStatus"),
    problems: (b, format) =>
      b.propertyStatus.map((s) => ({
        format,
        path: s.path,
        property: s.property,
        status: s.status,
        supersededBy: s.supersededBy,
      })),
    listProblems: true,
  },
  mismatch: {
    identity: MISMATCH,
    hasProblems: listHas("typeMismatches"),
    problems: (b, format) =>
      b.typeMismatches.map((m) => ({
        format,
        path: m.path,
        property: m.property,
        type: m.type,
        expected: m.expected,
      })),
    listProblems: true,
  },
  googleRequired: googleSpec(GOOGLE_REQUIRED, "missingRequired"),
  googleRecommended: googleSpec(GOOGLE_RECOMMENDED, "missingRecommended"),
  deprecated: {
    identity: DEPRECATED,
    hasProblems: listHas("deprecatedFeatures"),
    problems: (b, format) =>
      b.deprecatedFeatures.map((d) => ({ format, feature: d.feature, path: d.path, type: d.type })),
    extra: (problems) => {
      const features = distinct(problems);
      return {
        features,
        // The sentence for each feature, in the order `features` names them.
        restriction: features.map((id) => {
          const def = DEPRECATED_FEATURES.find((f) => f.id === id);
          if (def === undefined) {
            throw new Error(`${DEPRECATED.id}: feature '${id}' is not in DEPRECATED_FEATURES`);
          }
          return def.restriction;
        }),
      };
    },
    listProblems: false,
  },
} satisfies Record<string, PerPageSpec>;

const PROBLEMS_COLUMN = { key: "problems", label: "Problems" };
const FEATURES_COLUMN = { key: "features", label: "Features" };
const COUNT_COLUMN = { key: "problemCount", label: "Problem Count" };

function perPageRule(
  spec: PerPageSpec,
  checkIds: string[],
  columns: QueryRule["columns"],
): QueryRule {
  return defineRule<QueryRule>({
    kind: "query",
    id: spec.identity.id,
    checkIds,
    category: CATEGORY,
    severity: spec.identity.severity,
    columns,
    ...copyFor(spec.identity.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => perPageFindings(db, crawlId, capsOr(caps), spec),
  });
}

const templateRule: QueryRule = defineRule<QueryRule>({
  kind: "query",
  id: TEMPLATE.id,
  checkIds: ["CHECK-43"],
  category: CATEGORY,
  severity: TEMPLATE.severity,
  columns: [
    { key: "pageType", label: "Page Type" },
    { key: "schemaType", label: "Schema Type" },
    { key: "pagesWith", label: "Pages With" },
    { key: "pagesInType", label: "Pages In Type" },
  ],
  ...copyFor(TEMPLATE.id),
  rulesetVersion: RULESET_VERSION,
  run: (db, crawlId, caps, ctx) => {
    const { thresholds } = judgementOr(ctx);
    return templateFindings(
      db,
      crawlId,
      capsOr(caps),
      thresholds.SCHEMA_TEMPLATE_SHARE,
      thresholds.SCHEMA_TEMPLATE_MIN_PAGES,
    );
  },
});

export const schemaValidationRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: PARSE_ERROR.id,
    checkIds: ["CHECK-43"],
    category: CATEGORY,
    severity: PARSE_ERROR.severity,
    columns: [
      { key: "jsonLdParseErrors", label: "JSON-LD Parse Errors" },
      { key: "microdataErrors", label: "Microdata / RDFa Errors" },
    ],
    ...copyFor(PARSE_ERROR.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => parseErrorFindings(db, crawlId, capsOr(caps)),
  }),
  perPageRule(SPECS.unknownType, ["CHECK-43"], [PROBLEMS_COLUMN, COUNT_COLUMN]),
  perPageRule(SPECS.unknownProperty, ["CHECK-43"], [PROBLEMS_COLUMN, COUNT_COLUMN]),
  perPageRule(SPECS.pending, ["CHECK-43"], [PROBLEMS_COLUMN, COUNT_COLUMN]),
  perPageRule(SPECS.mismatch, ["CHECK-43"], [PROBLEMS_COLUMN, COUNT_COLUMN]),
  perPageRule(SPECS.googleRequired, ["CHECK-43", "CHECK-44"], [PROBLEMS_COLUMN, FEATURES_COLUMN, COUNT_COLUMN]),
  perPageRule(SPECS.googleRecommended, ["CHECK-43", "CHECK-44"], [PROBLEMS_COLUMN, FEATURES_COLUMN, COUNT_COLUMN]),
  perPageRule(
    SPECS.deprecated,
    ["CHECK-43"],
    [FEATURES_COLUMN, { key: "restriction", label: "Restriction" }, COUNT_COLUMN],
  ),
  templateRule,
];

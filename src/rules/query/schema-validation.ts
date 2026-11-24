/**
 * The per-node schema rules: what the node validator said about each stored
 * structured-data block (CHECK-43), judged by the schema.org vocabulary and the
 * JSON-LD, Microdata and RDFa specs.
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
 *  - `schema.empty-value`                      a property whose value is empty markup
 *  - `schema.unresolved-reference`             a bare `{"@id"}` no node on the page defines
 *  - `schema.template-inconsistent`            a page lacking the type most pages of its kind carry
 *
 * **One finding per page (ruling R0.3).** A page's problems ride in one
 * finding's evidence, up to `MAX_PROBLEMS_IN_EVIDENCE` of them plus the full
 * count; the per-node detail is the `structured_data_nodes` CSV view.
 *
 * **References resolve per page.** A bare reference is resolved when ANY block
 * of the same page defines its id — a graph split over two scripts is one
 * graph — so `schema.unresolved-reference` reads the page's blocks together
 * (`PageContext`), in SQL for the selection and in the reader for the list.
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

import { MAX_STRUCTURED_DATA_BLOCKS } from "../../crawl/parse/page-analyzer.js";
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
import { staleBlob } from "../schema-org/blob-sql.js";
import {
  MAX_PROBLEMS_PER_LIST,
  UNRESOLVED_COUNT_ISSUE,
  blockValidationObject,
  blockValidationSchema,
  unresolvedCountMatches,
  type BlockValidation,
  type ListName,
} from "../schema-org/validate.js";
import { assertCrawl, capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";
import { v4Gate } from "./page-facts.js";
import { judgementOr } from "../registry/types.js";

const CATEGORY = "structured-data" as const;

/**
 * Problems carried in one finding's evidence. `problemCount` counts every problem the
 * stored lists hold; each list stops at `MAX_PROBLEMS_PER_LIST` per block, and
 * `problemsCapped` says when one did.
 */
export const MAX_PROBLEMS_IN_EVIDENCE = 20;

const PARSE_ERROR: RuleIdentity = { id: "schema.parse-error", severity: "warning" };
const UNKNOWN_TYPE: RuleIdentity = { id: "schema.unknown-type", severity: "warning" };
const UNKNOWN_PROPERTY: RuleIdentity = { id: "schema.unknown-property", severity: "warning" };
const PENDING: RuleIdentity = { id: "schema.property-pending-or-superseded", severity: "info" };
const MISMATCH: RuleIdentity = { id: "schema.embedded-type-mismatch", severity: "warning" };
const EMPTY_VALUE: RuleIdentity = { id: "schema.empty-value", severity: "warning" };
const UNRESOLVED: RuleIdentity = { id: "schema.unresolved-reference", severity: "info" };
const TEMPLATE: RuleIdentity = { id: "schema.template-inconsistent", severity: "warning" };

type Problem = Record<string, unknown>;

interface BlockRow {
  id: number;
  format: string;
  /** The verdict, without `definedIds` unless the rule reads them (final review M7). */
  validation: unknown;
  /** `staleBlob` over the WHOLE stored verdict, so the projection never hides an old blob. */
  stale: boolean;
}

/** A verdict as a per-page rule reads it: `definedIds` only when the rule needs them. */
type BlockView = Omit<BlockValidation, "definedIds"> & { definedIds?: string[] };

/** The strict schema for a verdict selected without `definedIds` (final review M7). */
const blockValidationWithoutIdsSchema = blockValidationObject
  .omit({ definedIds: true })
  .refine(unresolvedCountMatches, UNRESOLVED_COUNT_ISSUE);

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

/** What a page's blocks say together: every id any of them defines, and how many left ids out (`idsTruncated`). */
interface PageContext {
  definedIds: ReadonlySet<string>;
  truncatedBlocks: number;
}

interface PerPageSpec {
  identity: RuleIdentity;
  /**
   * SQL over `sd` (and the page `p`) that is true when the block's verdict has
   * something for this rule. `crawlId` is for a check that reads the page's
   * other blocks.
   */
  hasProblems: (crawlId: string) => SQL;
  /** The problems one block contributes, in list order. */
  problems: (block: BlockView, format: string, page: PageContext) => Problem[];
  /**
   * The verdict lists the rule reads: when any was cut at
   * `MAX_PROBLEMS_PER_LIST` in any block of the page (`cappedLists`), the
   * finding's count is short and says so (`problemsCapped`, final review I1).
   */
  lists: readonly ListName[];
  /**
   * Whether the rule reads `definedIds`. They are uncapped, so a rule that does
   * not read them selects the verdict without them (final review M7).
   */
  readsDefinedIds?: true;
  /**
   * A rule whose count is not the length of `problems`: the page's exact count,
   * the ids behind it, and whether the count may be off. It replaces the
   * `problemCount` / `problemsCapped` the lists give, and the page is filed on
   * the strength of its count, not of `problems`.
   */
  summary?: (
    blocks: readonly BlockView[],
    page: PageContext,
  ) => { unresolved: string[]; unresolvedCount: number; unresolvedAtLeast: boolean; problemsCapped: boolean };
  /**
   * Silent on a crawl not wholly at extraction 4 (ruling R0.7): the answer
   * depends on blocks a page read before microdata and RDFa were extracted
   * would not have.
   */
  needsV4?: true;
  /**
   * Evidence about the page itself, and the columns that show it. For
   * `unresolved-reference`: whether the page's stored blocks reached the
   * analyzer's cap (`MAX_STRUCTURED_DATA_BLOCKS`), past which blocks were not
   * stored and the id may be defined (review I3, ruling: the fact is kept and
   * the uncertainty stated).
   */
  pageEvidence?: {
    columns: QueryRule["columns"];
    of: (page: { blockCount: number; hasParseErrors: boolean }) => Record<string, unknown>;
  };
}

const listHas = (key: string) => (): SQL =>
  sql`coalesce(jsonb_array_length(sd.validation_jsonb -> ${sql.raw(`'${key}'`)}), 0) > 0`;

/**
 * A reference of block `sd` that no block of page `p` defines, read from the
 * block's `unresolved` ids (the references no node of the block itself
 * defines; 29d). The list holds every one unless the block left ids out
 * (`idsTruncated`: one over `MAX_RESOLVED_ID_CHARS`, or past the block's
 * `MAX_BLOCK_ID_CHARS`), so the page-level answer is exact unless a block is
 * truncated. A block's ids count only while no OTHER block of the page is
 * truncated: that block's missing `definedIds` could have defined them, and
 * what is reported is a lower bound that must never rest on a guess
 * (`pageUnresolved` applies the same rule). A sibling block whose verdict is
 * null defines nothing here; the page is then selected and the reader throws
 * on that block, so the null is never read as "undefined".
 */
const unresolvedHas = (crawlId: string): SQL =>
  sql`(exists (
    select 1 from jsonb_array_elements(sd.validation_jsonb -> 'unresolved') r(id)
    where not exists (
      select 1 from structured_data d
      where d.crawl_id = ${crawlId} and d.page_id = p.id
        and d.validation_jsonb -> 'definedIds' @> jsonb_build_array(r.id)
    )
  ) and not exists (
    select 1 from structured_data t
    where t.crawl_id = ${crawlId} and t.page_id = p.id and t.id <> sd.id
      and t.validation_jsonb ->> 'idsTruncated' = 'true'
  ))`;

/**
 * The ids of a block's `unresolved` that no block of the page defines, in walk
 * order: none while another block of the page left ids out (see `unresolvedHas`).
 */
function pageUnresolved(b: BlockView, page: PageContext): string[] {
  if (page.truncatedBlocks - (b.idsTruncated ? 1 : 0) > 0) return [];
  return b.unresolved.filter((id) => !page.definedIds.has(id));
}

/**
 * `unresolved-reference`'s evidence: the page's unresolved ids (up to
 * `MAX_PROBLEMS_PER_LIST`, in block then walk order), their count, and
 * `problemsCapped`, true exactly when the count is over that limit. The count is
 * exact unless a block left ids out: `unresolvedAtLeast` is then true and the
 * count is a lower bound ("at least N").
 */
function unresolvedSummary(
  blocks: readonly BlockView[],
  page: PageContext,
): { unresolved: string[]; unresolvedCount: number; unresolvedAtLeast: boolean; problemsCapped: boolean } {
  const all = blocks.flatMap((b) => pageUnresolved(b, page));
  return {
    unresolved: all.slice(0, MAX_PROBLEMS_PER_LIST),
    unresolvedCount: all.length,
    unresolvedAtLeast: page.truncatedBlocks > 0,
    problemsCapped: all.length > MAX_PROBLEMS_PER_LIST,
  };
}

/**
 * One problem row per unresolved id of the block. The path and the id as
 * written come from the block's `references` (its first 50, in walk order,
 * matched by id and occurrence); an id past them has neither recorded, so
 * both are null, never guessed.
 */
function unresolvedProblems(b: BlockView, format: string, page: PageContext): Problem[] {
  const recorded = new Map<string, (typeof b.references)[number][]>();
  for (const r of b.references) recorded.set(r.id, [...(recorded.get(r.id) ?? []), r]);
  return pageUnresolved(b, page).map((id) => {
    const ref = recorded.get(id)?.shift();
    return { format, path: ref?.path ?? null, id, written: ref?.written ?? null };
  });
}

/** Every id the page's blocks define, as one set (`PageContext`); empty for a rule that reads none. */
function pageContext(blocks: readonly BlockView[]): PageContext {
  return {
    definedIds: new Set(blocks.flatMap((b) => b.definedIds ?? [])),
    truncatedBlocks: blocks.filter((b) => b.idsTruncated).length,
  };
}

async function perPageFindings(
  db: Db,
  crawlId: string,
  caps: RuleCaps,
  spec: PerPageSpec,
): Promise<Finding[]> {
  const ruleId = spec.identity.id;
  await assertCrawl(db, crawlId, ruleId);
  if (spec.needsV4 === true && !(await v4Gate(db, crawlId)).recorded) return [];

  // A page is selected when any block has something to say, has no verdict at
  // all, or has one in a shape this ruleset does not write (no `nodes` list:
  // written before the 29a rework); the latter two throw below. All of a
  // selected page's blocks come back, in id order, so the problems order is
  // block id then list order.
  const verdict =
    spec.readsDefinedIds === true ? sql`sd.validation_jsonb` : sql`(sd.validation_jsonb - 'definedIds')`;
  const result = await db.execute<{
    page_id: string;
    url: string;
    blocks: BlockRow[];
    has_parse_errors: boolean;
    total_matches: number;
  }>(sql`
    select p.id as page_id, p.url,
           jsonb_agg(
             jsonb_build_object(
               'id', sd.id, 'format', sd.format, 'validation', ${verdict},
               'stale', sd.validation_jsonb is not null and ${staleBlob(sql`sd.validation_jsonb`)})
             order by sd.id
           ) as blocks,
           (p.structured_data_parse_errors > 0
             or coalesce(p.structured_data_microdata_errors, 0) > 0) as has_parse_errors,
           count(*) over ()::int as total_matches
    from pages p
    join structured_data sd on sd.crawl_id = ${crawlId} and sd.page_id = p.id
    where p.crawl_id = ${crawlId}
      and ${JUDGED("p")}
    group by p.id, p.url, p.structured_data_parse_errors, p.structured_data_microdata_errors
    having bool_or(
      sd.validation_jsonb is null
      or ${staleBlob(sql`sd.validation_jsonb`)}
      or ${spec.hasProblems(crawlId)}
    )
    order by p.url
    ${limitTo(caps.listing)}`);

  const findings: Finding[] = [];
  for (const row of result.rows) {
    const parsed: { format: string; validation: BlockView }[] = [];
    for (const block of row.blocks) {
      if (block.validation === null || block.validation === undefined) {
        throw new Error(
          `${ruleId}: ${row.url} structured data has no validation — re-run the rules`,
        );
      }
      if (block.stale) {
        throw new Error(
          `${ruleId}: structured_data row ${block.id} of ${row.url} has a validation blob in a shape ` +
            "this ruleset does not write (re-run the rules)",
        );
      }
      const checked =
        spec.readsDefinedIds === true
          ? blockValidationSchema.safeParse(block.validation)
          : blockValidationWithoutIdsSchema.safeParse(block.validation);
      if (!checked.success) {
        // A blob in a shape this ruleset does not write — one from before the
        // 29a rework among them — is refused, never read.
        throw new Error(
          `${ruleId}: structured_data row ${block.id} of ${row.url} has a malformed validation blob ` +
            `(re-run the rules): ${checked.error.message}`,
        );
      }
      parsed.push({ format: block.format, validation: checked.data });
    }
    const page = pageContext(parsed.map((b) => b.validation));
    const all: Problem[] = parsed.flatMap((b) => spec.problems(b.validation, b.format, page));
    const summary = spec.summary?.(parsed.map((b) => b.validation), page);
    // The SQL selected the page on the strength of some block, so an empty
    // list here means the SQL pre-filter and the reader disagree.
    if ((summary === undefined ? all.length : summary.unresolvedCount) === 0) {
      throw new Error(
        `${ruleId}: ${row.url} was selected but no block lists a problem — the SQL pre-filter and the reader disagree`,
      );
    }
    findings.push(
      queryFinding(spec.identity, {
        pageId: row.page_id,
        pageUrl: row.url,
        evidence: {
          ...(spec.pageEvidence?.of({ blockCount: row.blocks.length, hasParseErrors: row.has_parse_errors }) ?? {}),
          problems: all.slice(0, MAX_PROBLEMS_IN_EVIDENCE),
          ...(summary === undefined
            ? {
                problemCount: all.length,
                problemsCapped: parsed.some((b) =>
                  b.validation.cappedLists.some((name) => spec.lists.includes(name)),
                ),
              }
            : { ...summary, problemCount: summary.unresolvedCount }),
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
 * page is not a member of any template. Types are EVERY type the page's
 * top-level nodes state (`nodes[].types` in the verdicts, final review I2): a
 * node typed WebPage and FAQPage carries both, and is not "lacking FAQPage".
 * Counted once per page. A judged block with no verdict, or one in a shape this
 * ruleset does not write, refuses the crawl: re-run the rules.
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
  const health = await db.execute<{ unreadable: number }>(sql`
    select count(*)::int as unreadable
    from pages p
    join structured_data sd on sd.crawl_id = ${crawlId} and sd.page_id = p.id
    where p.crawl_id = ${crawlId} and ${JUDGED("p")}
      and p.page_type is not null and p.page_type <> ''
      and (sd.validation_jsonb is null or ${staleBlob(sql`sd.validation_jsonb`)})`);
  const unreadable = health.rows[0]!.unreadable;
  if (unreadable > 0) {
    throw new Error(
      `${TEMPLATE.id}: crawl '${crawlId}' has ${unreadable} structured-data block(s) on typed judged ` +
        "pages with no validation, or one in a shape this ruleset does not write — re-run the rules",
    );
  }
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
    stated as (
      select t.id, t.page_type, nt.type as schema_type
      from typed t
      join structured_data sd on sd.crawl_id = ${crawlId} and sd.page_id = t.id
      cross join lateral jsonb_array_elements(sd.validation_jsonb -> 'nodes') as n(node)
      cross join lateral jsonb_array_elements_text(n.node -> 'types') as nt(type)
    ),
    carried as (
      select page_type, schema_type, count(distinct id)::int as c
      from stated
      group by page_type, schema_type
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
      select 1 from stated st
      where st.id = t.id and st.schema_type = tp.schema_type
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

const SPECS = {
  unknownType: {
    identity: UNKNOWN_TYPE,
    hasProblems: listHas("unknownTypes"),
    lists: ["unknownTypes"],
    problems: (b, format) => b.unknownTypes.map((t) => ({ format, path: t.path, type: t.type })),
  },
  unknownProperty: {
    identity: UNKNOWN_PROPERTY,
    hasProblems: listHas("unknownProperties"),
    lists: ["unknownProperties"],
    problems: (b, format) =>
      b.unknownProperties.map((u) => ({
        format,
        path: u.path,
        type: u.type,
        property: u.property,
      })),
  },
  pending: {
    identity: PENDING,
    hasProblems: listHas("propertyStatus"),
    lists: ["propertyStatus"],
    problems: (b, format) =>
      b.propertyStatus.map((s) => ({
        format,
        path: s.path,
        property: s.property,
        status: s.status,
        supersededBy: s.supersededBy,
      })),
  },
  mismatch: {
    identity: MISMATCH,
    hasProblems: listHas("typeMismatches"),
    lists: ["typeMismatches"],
    problems: (b, format) =>
      b.typeMismatches.map((m) => ({
        format,
        path: m.path,
        property: m.property,
        type: m.type,
        expected: m.expected,
      })),
  },
  emptyValue: {
    identity: EMPTY_VALUE,
    hasProblems: listHas("emptyValues"),
    lists: ["emptyValues"],
    problems: (b, format) =>
      b.emptyValues.map((e) => ({ format, path: e.path, type: e.type, property: e.property })),
  },
  unresolved: {
    identity: UNRESOLVED,
    hasProblems: unresolvedHas,
    lists: ["references"],
    readsDefinedIds: true,
    summary: unresolvedSummary,
    problems: unresolvedProblems,
    needsV4: true,
    pageEvidence: {
      columns: [
        { key: "blocksAtCap", label: "Blocks At Cap" },
        { key: "pageHasParseErrors", label: "Page Has Parse Errors" },
      ],
      // A block past the analyzer's cap was not stored, and one that did not
      // parse was not read: either may define the id (final review M1).
      of: ({ blockCount, hasParseErrors }) => ({
        blocksAtCap: blockCount >= MAX_STRUCTURED_DATA_BLOCKS,
        pageHasParseErrors: hasParseErrors,
      }),
    },
  },
} satisfies Record<string, PerPageSpec>;

const PROBLEMS_COLUMN = { key: "problems", label: "Problems" };
const COUNT_COLUMN = { key: "problemCount", label: "Problem Count" };
const CAPPED_COLUMN = { key: "problemsCapped", label: "Problems Capped" };
const UNRESOLVED_COLUMNS = [
  { key: "unresolved", label: "Unresolved Ids" },
  { key: "unresolvedCount", label: "Unresolved Count" },
  { key: "unresolvedAtLeast", label: "Unresolved At Least" },
];

function perPageRule(spec: PerPageSpec, checkIds: string[]): QueryRule {
  return defineRule<QueryRule>({
    kind: "query",
    id: spec.identity.id,
    checkIds,
    category: CATEGORY,
    severity: spec.identity.severity,
    columns: [
      PROBLEMS_COLUMN,
      ...(spec.pageEvidence?.columns ?? []),
      ...(spec.summary === undefined ? [] : UNRESOLVED_COLUMNS),
      COUNT_COLUMN,
      CAPPED_COLUMN,
    ],
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
  perPageRule(SPECS.unknownType, ["CHECK-43"]),
  perPageRule(SPECS.unknownProperty, ["CHECK-43"]),
  perPageRule(SPECS.pending, ["CHECK-43"]),
  perPageRule(SPECS.mismatch, ["CHECK-43"]),
  perPageRule(SPECS.emptyValue, ["CHECK-43"]),
  perPageRule(SPECS.unresolved, ["CHECK-43"]),
  templateRule,
];

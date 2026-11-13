/**
 * The structured-data rules: what the site's JSON-LD says, and what it does not.
 *
 * Three questions, none of which a page rule can answer. Two are about the SITE
 * as a whole — does it publish structured data at all (CHECK-43), does anything
 * on it mark up a breadcrumb trail (CHECK-45) — and one reads the
 * `structured_data` table the crawler filled:
 *
 *  - `schema.none-on-site`          no block of any type, anywhere
 *  - `schema.breadcrumb-absent`     no BreadcrumbList on a site big enough to want one
 *  - `schema.self-serving-reviews`  a business rating itself
 *
 * Nothing here fetches (hard rule 2) and nothing loads a table into memory
 * (hard rule 3): the site-scoped pair are two `exists` and a `count`, and the
 * per-page rule selects from `structured_data` under the run's finding cap.
 *
 * **The two site-scoped rules deliberately overlap.** A site with no structured
 * data at all fires both, because they are two different pieces of advice: one
 * says the site publishes nothing a search engine can read as data, the other
 * says its pages carry no navigational trail. A client fixing the second has
 * not fixed the first.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { hasValue } from "../schema-org/values.js";
import { JUDGED, queryFinding, type RuleIdentity } from "../helpers.js";
import { copyFor } from "../registry/copy/index.js";
import {
  defineRule,
  RULESET_VERSION,
  type Finding,
  type QueryRule,
} from "../registry/registry.js";
import type { RuleCaps } from "../registry/types.js";
import { assertCrawl, capsOr, limitTo, noteTruncation } from "./crawl-evidence.js";
import { v4Gate } from "./page-facts.js";
import { descendants } from "../schema-org/vocabulary.js";
import {
  BREADCRUMB_PAGE_FLOOR,
  NONE_PAGE_FLOOR,
} from "../thresholds.js";

const CATEGORY = "structured-data" as const;

const NONE: RuleIdentity = { id: "schema.none-on-site", severity: "info" };
const BREADCRUMB_ABSENT: RuleIdentity = { id: "schema.breadcrumb-absent", severity: "info" };
const SELF_SERVING: RuleIdentity = { id: "schema.self-serving-reviews", severity: "info" };

/** The `@type` string the breadcrumb rule is about, as the analyzer stores it. */
export const BREADCRUMB_TYPE = "BreadcrumbList";

/** Verdict thresholds live in `../thresholds.js`; re-exported so every existing import still resolves. */
export {
  BREADCRUMB_PAGE_FLOOR,
  NONE_PAGE_FLOOR,
} from "../thresholds.js";


/**
 * The types Google's review-snippet policy calls self-serving when they carry
 * their own rating, and the two fields that carry it.
 *
 * Reviews of a PRODUCT are exactly what the markup is for; reviews an
 * organisation publishes about itself are the case the policy names, and
 * Google ignores them for rich results.
 *
 * Matched against the whole Organization branch of the schema.org hierarchy
 * (`descendants`, which includes the type itself), so `LocalBusiness`,
 * `Restaurant`, `Dentist` and every other subtype are reported.
 */
export const SELF_SERVING_TYPES: readonly string[] = descendants("Organization");
export const SELF_SERVING_FIELDS: readonly string[] = ["aggregateRating", "review"];

/**
 * The pages these rules count as the site: the JUDGED cohort (fetched OK, 200,
 * indexable, not canonicalised elsewhere — `JUDGED`, src/rules/helpers.ts).
 *
 * Phase 22 §1 moved these rules onto it, the site-scoped ones through this
 * constant and the page-scoped one through the `JUDGED("p")` on its own join —
 * which it had no cohort filter of any kind before. The retired
 * `schema.product-incomplete` fired 40 times on the raelon.ca crawl and 10 of
 * those were pages a canonical had already handed elsewhere.
 */
const INDEXABLE = JUDGED("p");

/**
 * How big the crawl found the site to be, in pages a search engine may index.
 *
 * Both site-scoped rules carry it as evidence rather than as a threshold they
 * merely applied: "no structured data" on a crawl of four hundred pages and on
 * a crawl that fetched nothing are very different statements, and the number
 * beside the finding is what tells them apart.
 */
async function siteShape(
  db: Db,
  crawlId: string,
  blockFilter: SQL | null,
): Promise<{ hasBlocks: boolean; indexablePages: number }> {
  const result = await db.execute<{ has_blocks: boolean; indexable_pages: number }>(sql`
    select
      exists (
        select 1 from structured_data sd
        where sd.crawl_id = ${crawlId}${blockFilter === null ? sql`` : blockFilter}
      ) as has_blocks,
      (
        select count(*) from pages p
        where p.crawl_id = ${crawlId} and ${INDEXABLE}
      )::int as indexable_pages`);
  const row = result.rows[0];
  // One row, always: both scalars are subqueries over a constant select. A
  // missing row would mean the query is not the query written above.
  if (row === undefined) {
    throw new Error(`structured-data rules: crawl '${crawlId}' site shape query returned no row`);
  }
  return { hasBlocks: row.has_blocks, indexablePages: row.indexable_pages };
}

/**
 * A site whose crawl stored no structured data of any type (CHECK-43).
 *
 * Any type at all, not just the profiled ones: the question is whether the site
 * describes itself in a machine-readable way, and an `Article` or an
 * `FAQPage` answers it as well as a `Product` does.
 *
 * Info, and site-scoped. It is one decision to make — "should this site publish
 * structured data" — rather than a fault on any one page, and the answer is
 * sometimes no.
 *
 * **The one-page floor.** A crawl with no indexable page is silent: "this site
 * publishes no structured data" would be a claim about a site this crawl never
 * read. That floor is `indexablePages`, not "pages fetched", so it conflates two
 * situations — a crawl that reached nothing at all, and a crawl that reached a
 * site whose every page is noindexed or non-200. The second goes unreported
 * here, deliberately: a site with nothing to index has no rich result to earn,
 * and its real problem is the noindex, which the indexability rules report by
 * name. The number the finding carries is the same one the floor is drawn on,
 * so a reader is never told a threshold was applied to a figure they cannot see.
 */
async function noneOnSiteFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await assertCrawl(db, crawlId, NONE.id);
  // Microdata and RDFa are read from extraction 4 on: below it "no blocks" may
  // only mean "not read" (R0.7). `extraction.not-recorded` speaks for the crawl.
  if (!(await v4Gate(db, crawlId)).recorded) return [];
  const { hasBlocks, indexablePages } = await siteShape(db, crawlId, null);
  if (hasBlocks || indexablePages < NONE_PAGE_FLOOR) return [];
  return [
    queryFinding(NONE, {
      pageId: null,
      pageUrl: null,
      evidence: { indexablePages },
      dedupeKey: "site",
    }),
  ];
}

/**
 * A site of some size with no BreadcrumbList anywhere (CHECK-45).
 *
 * The floor is what keeps this from being advice about a site that has no
 * hierarchy to describe (see `BREADCRUMB_PAGE_FLOOR`). Past it, the rule reports
 * the absence of the markup and nothing else: whether each trail is complete,
 * and what share of pages carry one, is the validation blob and Phase 4's
 * coverage metric.
 */
async function breadcrumbFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await assertCrawl(db, crawlId, BREADCRUMB_ABSENT.id);
  // As `schema.none-on-site`: a breadcrumb in microdata is invisible below v4 (R0.7).
  if (!(await v4Gate(db, crawlId)).recorded) return [];
  const { hasBlocks, indexablePages } = await siteShape(
    db,
    crawlId,
    sql` and sd.schema_type = ${BREADCRUMB_TYPE}`,
  );
  if (hasBlocks || indexablePages < BREADCRUMB_PAGE_FLOOR) return [];
  return [
    queryFinding(BREADCRUMB_ABSENT, {
      pageId: null,
      pageUrl: null,
      evidence: { indexablePages },
      dedupeKey: "site",
    }),
  ];
}

/**
 * Organization and LocalBusiness blocks carrying their own rating or reviews
 * (CHECK-46).
 *
 * One finding per (page, type): a page with two Organization blocks has one
 * problem, and the fields named are the union of what those blocks carry.
 *
 * The SQL narrows to blocks whose raw JSON has one of the two keys, and
 * `hasValue` — shared with the schema-org checks — decides. A `review: []` is a
 * key with nothing under it, and reporting a page for reviews it does not
 * publish would be a false accusation; the total is corrected for every group
 * the check rejects, so the truncation note never counts a row nobody listed.
 * Only the two field VALUES are read into memory, never the whole block.
 */
async function selfServingFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await assertCrawl(db, crawlId, SELF_SERVING.id);
  const types = sql.param([...SELF_SERVING_TYPES]);

  const result = await db.execute<{
    page_id: string;
    url: string;
    schema_type: string;
    aggregate_ratings: unknown[];
    reviews: unknown[];
    total_matches: number;
  }>(sql`
    select sd.page_id, p.url, sd.schema_type,
           jsonb_agg(sd.raw_jsonb -> 'aggregateRating') as aggregate_ratings,
           jsonb_agg(sd.raw_jsonb -> 'review') as reviews,
           count(*) over ()::int as total_matches
    from structured_data sd
    join pages p on p.crawl_id = ${crawlId} and p.id = sd.page_id
    where sd.crawl_id = ${crawlId}
      and ${INDEXABLE}
      and sd.schema_type = any(${types}::text[])
      and (
        jsonb_exists(sd.raw_jsonb, 'aggregateRating')
        or jsonb_exists(sd.raw_jsonb, 'review')
      )
    group by sd.page_id, p.url, sd.schema_type
    order by p.url, sd.schema_type
    ${limitTo(caps.listing)}`);

  const findings: Finding[] = [];
  let total = result.rows[0]?.total_matches ?? 0;
  for (const row of result.rows) {
    const carried: Record<string, unknown[]> = {
      aggregateRating: row.aggregate_ratings,
      review: row.reviews,
    };
    // Named in the order `SELF_SERVING_FIELDS` states them, so two findings
    // never disagree about how a page's fields are listed.
    const fields = SELF_SERVING_FIELDS.filter((name) =>
      (carried[name] ?? []).some((value) => hasValue(value)),
    );
    if (fields.length === 0) {
      total -= 1;
      continue;
    }
    findings.push(
      queryFinding(SELF_SERVING, {
        pageId: row.page_id,
        pageUrl: row.url,
        evidence: { schemaType: row.schema_type, fields },
        // Page and type: one page may carry both an Organization and a
        // LocalBusiness block, and they are two findings with two fixes.
        dedupeKey: `${row.url}#${row.schema_type}`,
      }),
    );
  }
  return noteTruncation(findings, total);
}

export const structuredDataRules: QueryRule[] = [
  defineRule<QueryRule>({
    kind: "query",
    id: NONE.id,
    needsSpider: true,
    checkIds: ["CHECK-43"],
    category: CATEGORY,
    severity: NONE.severity,
    columns: [{ key: "indexablePages", label: "Indexable Pages" }],
    ...copyFor(NONE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => noneOnSiteFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: BREADCRUMB_ABSENT.id,
    needsSpider: true,
    checkIds: ["CHECK-45"],
    category: CATEGORY,
    severity: BREADCRUMB_ABSENT.severity,
    columns: [{ key: "indexablePages", label: "Indexable Pages" }],
    ...copyFor(BREADCRUMB_ABSENT.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => breadcrumbFindings(db, crawlId, capsOr(caps)),
  }),

  defineRule<QueryRule>({
    kind: "query",
    id: SELF_SERVING.id,
    checkIds: ["CHECK-46"],
    category: CATEGORY,
    severity: SELF_SERVING.severity,
    columns: [
      { key: "schemaType", label: "Schema Type" },
      { key: "fields", label: "Fields" },
    ],
    ...copyFor(SELF_SERVING.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => selfServingFindings(db, crawlId, capsOr(caps)),
  }),
];

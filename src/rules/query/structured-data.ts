/**
 * The structured-data rules: what the site's JSON-LD says, and what it does not.
 *
 * Four questions, none of which a page rule can answer. Two are about the SITE
 * as a whole — does it publish structured data at all (CHECK-43), does anything
 * on it mark up a breadcrumb trail (CHECK-45) — and two read the
 * `structured_data` table the crawler filled, one of them through the field
 * presence the derivation computed from it:
 *
 *  - `schema.none-on-site`          no block of any type, anywhere
 *  - `schema.product-incomplete`    a Product missing a field the rich result needs
 *  - `schema.breadcrumb-absent`     no BreadcrumbList on a site big enough to want one
 *  - `schema.self-serving-reviews`  a business rating itself
 *
 * Nothing here fetches (hard rule 2) and nothing loads a table into memory
 * (hard rule 3): the site-scoped pair are two `exists` and a `count`, and the
 * two per-page rules select from `structured_data` under the run's finding cap.
 *
 * **The two site-scoped rules deliberately overlap.** A site with no structured
 * data at all fires both, because they are two different pieces of advice: one
 * says the site publishes nothing a search engine can read as data, the other
 * says its pages carry no navigational trail. A client fixing the second has
 * not fixed the first.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import {
  SCHEMA_PROFILES,
  hasValue,
  type SchemaProfile,
} from "../derive/field-presence.js";
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
import {
  BREADCRUMB_PAGE_FLOOR,
  NONE_PAGE_FLOOR,
} from "../thresholds.js";

const CATEGORY = "structured-data" as const;

const NONE: RuleIdentity = { id: "schema.none-on-site", severity: "info" };
const PRODUCT_INCOMPLETE: RuleIdentity = { id: "schema.product-incomplete", severity: "warning" };
const BREADCRUMB_ABSENT: RuleIdentity = { id: "schema.breadcrumb-absent", severity: "info" };
const SELF_SERVING: RuleIdentity = { id: "schema.self-serving-reviews", severity: "info" };

/** The `@type` strings two of these rules are about, as the analyzer stores them. */
export const PRODUCT_TYPE = "Product";
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
 * Matched as exact `@type` strings, so the SUBTYPES of LocalBusiness —
 * `Restaurant`, `Store`, `Dentist` and the rest of that branch — are not
 * reported, and neither are the subtypes of Organization. The policy covers
 * them; this rule under-reports them, which is the safe direction (a missed
 * finding, never a false one) but is a real gap: a restaurant rating itself
 * goes unnamed here. Widening it means enumerating the schema.org hierarchy,
 * which is a data set this engine does not carry today.
 */
export const SELF_SERVING_TYPES: readonly string[] = ["Organization", "LocalBusiness"];
export const SELF_SERVING_FIELDS: readonly string[] = ["aggregateRating", "review"];

/**
 * The two type names above must be types the derivation profiles: the Product
 * rule reads its profile to name the fields a block is missing, and the
 * breadcrumb rule reports the absence of a type whose presence the derivation
 * would judge. Checked at module load rather than assumed — a profile renamed
 * without these would leave a rule reporting on a type nothing derives.
 */
for (const type of [PRODUCT_TYPE, BREADCRUMB_TYPE]) {
  if (SCHEMA_PROFILES[type] === undefined) {
    throw new Error(
      `structured-data rules: '${type}' has no entry in SCHEMA_PROFILES, so the ` +
        "rules that read its profile cannot describe what a block is missing",
    );
  }
}

/**
 * The pages these rules count as the site: the JUDGED cohort (fetched OK, 200,
 * indexable, not canonicalised elsewhere — `JUDGED`, src/rules/helpers.ts).
 *
 * Phase 22 §1 moved all four rules here onto it, the two site-scoped ones
 * through this constant and the two page-scoped ones through the `JUDGED("p")`
 * on their own joins — which they had no cohort filter of any kind before.
 * `schema.product-incomplete` fired 40 times on the raelon.ca crawl and 10 of
 * those were pages a canonical had already handed elsewhere: the same Product
 * block, reported once for the URL that owns it and three times for the
 * collection paths that defer to it.
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
 * and what share of pages carry one, is the derivation's presence blob and
 * Phase 4's coverage metric.
 */
async function breadcrumbFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await assertCrawl(db, crawlId, BREADCRUMB_ABSENT.id);
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
 * The stored presence blob, checked against the shape the derivation writes
 * rather than cast to it.
 *
 * Same reasoning as `parseDiscovery` in crawl-evidence.ts, with a sharper edge:
 * this rule's finding is a LIST OF FIELD NAMES a client will go and add. A blob
 * whose `required` is missing a field the profile names — a row derived under
 * an older profile — would silently drop that field from every finding, and the
 * check that exists to report it would stop reporting it. A null blob is its
 * own case: the derivation did not run, which is a broken run rather than a
 * complete Product (hard rule 7).
 */
function missingFields(
  presence: unknown,
  profile: SchemaProfile,
  pageUrl: string,
): { missingRequired: string[]; missingRecommended: string[] } {
  const bad = (why: string): never => {
    throw new Error(`${PRODUCT_INCOMPLETE.id}: ${pageUrl} field presence ${why}`);
  };
  if (presence === null || presence === undefined) {
    return bad(
      "is missing — `deriveFieldPresence` writes it for every Product block, so " +
        "either the derivation did not run for this crawl or it failed; re-run " +
        "the rules rather than reading a null blob as an empty product",
    );
  }
  if (typeof presence !== "object" || Array.isArray(presence)) return bad("is not an object");
  const blob = presence as Record<string, unknown>;

  const missing = (group: "required" | "recommended", names: readonly string[]): string[] => {
    const values = blob[group];
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      return bad(`has no ${group} object`);
    }
    const judged = values as Record<string, unknown>;
    const absent: string[] = [];
    for (const name of names) {
      const value = judged[name];
      if (typeof value !== "boolean") {
        return bad(
          `does not judge '${name}', which the ${group} profile names — the blob was ` +
            "derived under a different profile; re-run the rules",
        );
      }
      if (!value) absent.push(name);
    }
    // Profile order, not the blob's key order: the fields are listed to a
    // client in the order the profile states them.
    return absent;
  };

  return {
    missingRequired: missing("required", profile.required),
    missingRecommended: missing("recommended", profile.recommended),
  };
}

/**
 * Pages whose Product markup is missing a required field (CHECK-44).
 *
 * One finding per PAGE, off the presence the derivation wrote. Because that
 * presence is the union across the page's Product blocks (see the derivation's
 * group contract), a field reported missing here is missing from EVERY Product
 * block on the page — which is what the copy says.
 *
 * The SQL is a pre-filter and `missingFields` is the authority: a row whose
 * blob turns out to name no missing required field produces no finding, and
 * because the SQL admitted it that disagreement is a defect rather than a
 * silence — it throws, like `content.soft-404`'s unexplained match.
 *
 * **Every non-conforming blob is pulled INTO that check rather than filtered
 * out**, which is what makes the refusal loud rather than decorative. The
 * predicate is deliberately wider than "carries a false", because
 * `jsonb_path_exists` runs in lax mode and answers *false* — not an error — for
 * a blob that is a scalar, an array, or an object with no `required` at all, and
 * an all-true blob derived under an older profile would also slip past a
 * false-only test. So the WHERE clause admits: a null blob; anything that is not
 * an object; a missing or non-object `required`/`recommended`; a group that does
 * not judge every field the profile names (the stale-profile case); a value that
 * is not a boolean; and, finally, a real false. Each of the first five lands on
 * a named branch of `missingFields`, which throws telling the reader to re-run
 * the rules.
 */
async function productFindings(db: Db, crawlId: string, caps: RuleCaps): Promise<Finding[]> {
  await assertCrawl(db, crawlId, PRODUCT_INCOMPLETE.id);
  const profile = SCHEMA_PROFILES[PRODUCT_TYPE]!;

  const result = await db.execute<{
    page_id: string;
    url: string;
    presence: unknown;
    total_matches: number;
  }>(sql`
    with product as (
      select distinct sd.page_id, sd.field_presence_jsonb as presence
      from structured_data sd
      where sd.crawl_id = ${crawlId} and sd.schema_type = ${PRODUCT_TYPE}
    )
    select pr.page_id, p.url, pr.presence,
           count(*) over ()::int as total_matches
    from product pr
    join pages p on p.crawl_id = ${crawlId} and p.id = pr.page_id
    where ${INDEXABLE} and (
       pr.presence is null
       -- "is distinct from", not "<>": a missing key makes jsonb_typeof NULL,
       -- and NULL <> 'object' is NULL — which a WHERE clause reads as "no",
       -- so the blob that omits a whole group would be the one shape to escape.
       or jsonb_typeof(pr.presence) is distinct from 'object'
       or jsonb_typeof(pr.presence -> 'required') is distinct from 'object'
       or jsonb_typeof(pr.presence -> 'recommended') is distinct from 'object'
       or not coalesce(
            jsonb_exists_all(pr.presence -> 'required', ${sql.param([
              ...profile.required,
            ])}::text[]), false)
       or not coalesce(
            jsonb_exists_all(pr.presence -> 'recommended', ${sql.param([
              ...profile.recommended,
            ])}::text[]), false)
       or jsonb_path_exists(pr.presence, '$.required.* ? (@.type() != "boolean")')
       or jsonb_path_exists(pr.presence, '$.recommended.* ? (@.type() != "boolean")')
       or jsonb_path_exists(pr.presence, '$.required.* ? (@ == false)'))
    order by p.url
    ${limitTo(caps.listing)}`);

  const findings: Finding[] = [];
  // Exact: every row the query listed becomes a finding or throws, so the
  // window count needs no correction (unlike the self-serving rule below).
  const total = result.rows[0]?.total_matches ?? 0;
  for (const row of result.rows) {
    const { missingRequired, missingRecommended } = missingFields(row.presence, profile, row.url);
    if (missingRequired.length === 0) {
      throw new Error(
        `${PRODUCT_INCOMPLETE.id}: ${row.url} matched the query but its presence blob ` +
          "names no missing required field",
      );
    }
    findings.push(
      queryFinding(PRODUCT_INCOMPLETE, {
        pageId: row.page_id,
        pageUrl: row.url,
        evidence: { missingRequired, missingRecommended },
        dedupeKey: row.url,
      }),
    );
  }
  return noteTruncation(findings, total);
}

/**
 * Organization and LocalBusiness blocks carrying their own rating or reviews
 * (CHECK-46).
 *
 * One finding per (page, type): a page with two Organization blocks has one
 * problem, and the fields named are the union of what those blocks carry.
 *
 * The SQL narrows to blocks whose raw JSON has one of the two keys, and
 * `hasValue` — the derivation's own predicate — decides. A `review: []` is a
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
    id: PRODUCT_INCOMPLETE.id,
    checkIds: ["CHECK-44"],
    category: CATEGORY,
    severity: PRODUCT_INCOMPLETE.severity,
    columns: [
      { key: "missingRequired", label: "Missing Required Fields" },
      { key: "missingRecommended", label: "Missing Recommended Fields" },
    ],
    ...copyFor(PRODUCT_INCOMPLETE.id),
    rulesetVersion: RULESET_VERSION,
    run: (db, crawlId, caps) => productFindings(db, crawlId, capsOr(caps)),
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
